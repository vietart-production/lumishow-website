const { PayOS } = require("@payos/node");
const { db } = require("../config/firebase");
const { getPaymentStatus } = require("./payment.service");
const { releaseExpiredHold } = require("./booking.service");
const { releaseCouponUse } = require("./coupon.service");

// ==========================================
// ĐỐI SOÁT ĐƠN TREO — LƯỚI AN TOÀN CHO C6
// ------------------------------------------
// Vé chỉ được chốt khi tab khách còn mở poll, hoặc webhook PayOS (chưa
// đăng ký). Khách trả tiền rồi đóng tab/mất mạng → đơn treo
// PENDING_PAYMENT vĩnh viễn. Hàm này quét mọi đơn PENDING_PAYMENT, hỏi
// thẳng PayOS, và chốt (cấp vé + gửi mail) đơn nào đã trả đủ. Dùng lại
// getPaymentStatus() (idempotent, đã đối chiếu số tiền) nên gọi nhiều lần
// không tạo vé đôi.
//
// (2026-09-16) Nửa còn lại của C6: đơn KHÔNG được trả (PayOS xác nhận chưa
// nhận tiền) trước đây cứ treo PENDING_PAYMENT vĩnh viễn — không có gì
// từng chuyển nó sang EXPIRED. Giờ nếu đơn quá EXPIRE_AFTER_MS mà PayOS vẫn
// báo chưa trả, tự chuyển orderStatus -> "EXPIRED", hoàn lượt coupon đã giữ
// (nếu có) và giải phóng hold liên quan (idempotent, thường đã tự hết hạn
// từ trước qua cleanupExpiredHolds rồi nên chỉ là lưới an toàn thêm).
//
// Dùng bởi: scripts/reconcilePendingOrders.js (chạy tay/Cron) và vòng lặp
// nền trong index.js (tự chạy khi instance còn thức).
// ==========================================

const payos = new PayOS({
    clientId: process.env.PAYOS_CLIENT_ID,
    apiKey: process.env.PAYOS_API_KEY,
    checksumKey: process.env.PAYOS_CHECKSUM_KEY
});

// Dư sức so với HOLD_DURATION_MS (10 phút) — tránh huỷ nhầm đơn đang thực sự
// chờ khách chuyển khoản chậm, nhưng vẫn dọn đơn treo trong cùng ngày thay
// vì để lơ lửng nhiều ngày như trước.
const EXPIRE_AFTER_MS = 60 * 60 * 1000;

async function expireOrder(orderId, order) {

    await db.collection("orders").doc(orderId).update({
        orderStatus: "EXPIRED",
        paymentStatus: "EXPIRED",
        updatedAt: new Date()
    });

    if (order.coupon && order.coupon.code) {
        await releaseCouponUse(order.coupon.code);
    }

    if (order.holdId) {
        // No-op nếu hold không còn ACTIVE/chưa hết hạn — chỉ là lưới an toàn.
        await releaseExpiredHold(order.holdId).catch(() => {});
    }
}

async function reconcilePendingOrders({ commit = false, log = () => {} } = {}) {

    const snap = await db.collection("orders")
        .where("orderStatus", "==", "PENDING_PAYMENT")
        .get();

    const now = new Date();
    let paid = 0, committed = 0, expired = 0, other = 0, failed = 0;

    for (const doc of snap.docs) {
        const o = doc.data();
        const tag = `${doc.id} | orderCode ${o.orderCode} | ${o.customerName || "?"} | ${o.amount}đ`;

        try {
            const pl = await payos.paymentRequests.get(o.orderCode);

            if (pl.status === "PAID") {
                paid++;
                log(`[ĐÃ TRẢ] ${tag} — PayOS nhận ${pl.amountPaid}đ`);

                if (commit) {
                    const r = await getPaymentStatus(doc.id);
                    committed++;
                    log(`   -> ĐÃ CHỐT: orderStatus=${r.orderStatus}`);
                }
                continue;
            }

            const createdAt = o.createdAt?.toDate ? o.createdAt.toDate() : new Date(o.createdAt);
            const ageMs = now - createdAt;

            if (ageMs > EXPIRE_AFTER_MS) {
                expired++;
                log(`[HẾT HẠN, CHƯA TRẢ] ${tag} — PayOS: ${pl.status}, tạo ${Math.round(ageMs / 60000)} phút trước`);

                if (commit) {
                    await expireOrder(doc.id, o);
                    log("   -> ĐÃ CHUYỂN EXPIRED");
                }
            } else {
                other++;
                log(`[${pl.status}] ${tag}`);
            }
        } catch (error) {
            failed++;
            log(`[LỖI] ${tag}: ${error.message}`);
        }
    }

    return { total: snap.size, paid, committed, expired, other, failed };
}

module.exports = { reconcilePendingOrders };
