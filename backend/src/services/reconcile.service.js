const { PayOS } = require("@payos/node");
const { db } = require("../config/firebase");
const { getPaymentStatus } = require("./payment.service");

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
// Dùng bởi: scripts/reconcilePendingOrders.js (chạy tay/Cron) và vòng lặp
// nền trong index.js (tự chạy khi instance còn thức).
// ==========================================

const payos = new PayOS({
    clientId: process.env.PAYOS_CLIENT_ID,
    apiKey: process.env.PAYOS_API_KEY,
    checksumKey: process.env.PAYOS_CHECKSUM_KEY
});

async function reconcilePendingOrders({ commit = false, log = () => {} } = {}) {

    const snap = await db.collection("orders")
        .where("orderStatus", "==", "PENDING_PAYMENT")
        .get();

    let paid = 0, committed = 0, other = 0, failed = 0;

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
            } else {
                other++;
                log(`[${pl.status}] ${tag}`);
            }
        } catch (error) {
            failed++;
            log(`[LỖI] ${tag}: ${error.message}`);
        }
    }

    return { total: snap.size, paid, committed, other, failed };
}

module.exports = { reconcilePendingOrders };
