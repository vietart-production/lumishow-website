const path = require("path");

require("dotenv").config({
    path: path.resolve(__dirname, "../../.env")
});

const crypto = require("crypto");

const { db } = require("../config/firebase");
const { getHoldStatus } = require("./booking.service");
const { reserveCouponToAmount, releaseCouponUse } = require("./coupon.service");
const { finalizeOrderAsPaid } = require("./payment.service");
const { sendTechAlertEmail } = require("./email.service");

// ==========================================
// CỔNG THANH TOÁN THẺ QUỐC TẾ ONEPAY (song song với PayOS, không thay thế)
// ------------------------------------------
// Tài liệu: "Tài liệu hướng dẫn tích hợp cổng thanh toán OnePay" HD01-KT-TS v03.
// Luồng: backend ký URL GET sang vpcpay.op → khách thanh toán trên OnePay →
// OnePay trả kết quả qua 2 đường (ReturnURL qua trình duyệt khách, IPN
// server-to-server). Cả hai đi qua processOnepayResult() — một hàm duy nhất,
// idempotent, đã kiểm tra chữ ký + số tiền — rồi chốt vé bằng đúng
// finalizeOrderAsPaid() dùng chung với PayOS/VNPay.
//
// Biến môi trường (KHÔNG đặt trong code/frontend — tài liệu mục IV.1.5):
//   ONEPAY_MERCHANT, ONEPAY_ACCESS_CODE, ONEPAY_HASH_CODE   (OnePay cấp)
//   ONEPAY_QUERY_USER, ONEPAY_QUERY_PASSWORD                (cho QueryDR)
//   ONEPAY_PAYMENT_URL  (mặc định sandbox mtf.onepay.vn; production onepay.vn)
//   ONEPAY_QUERY_URL    (mặc định sandbox)
//   ONEPAY_CURRENCY     (mặc định VND — phải khớp loại tiền của merchant ID)
//   ONEPAY_CARD_LIST    (mặc định INTERCARD = chỉ thẻ quốc tế Visa/MC/JCB/AE/CUP)
//   ONEPAY_BACKEND_URL  (gốc URL public của backend; mặc định RENDER_EXTERNAL_URL)
// ==========================================

const ONEPAY_PAYMENT_URL = process.env.ONEPAY_PAYMENT_URL || "https://mtf.onepay.vn/paygate/vpcpay.op";
const ONEPAY_QUERY_URL = process.env.ONEPAY_QUERY_URL || "https://mtf.onepay.vn/msp/api/v1/vpc/invoices/queries";
const ONEPAY_CURRENCY = process.env.ONEPAY_CURRENCY || "VND";
const ONEPAY_CARD_LIST = process.env.ONEPAY_CARD_LIST || "INTERCARD";

const BACKEND_URL =
    process.env.ONEPAY_BACKEND_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "https://lumishow-website.onrender.com";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://127.0.0.1:5500";

function getCreds() {
    const merchant = process.env.ONEPAY_MERCHANT;
    const accessCode = process.env.ONEPAY_ACCESS_CODE;
    const hashCode = process.env.ONEPAY_HASH_CODE;

    if (!merchant || !accessCode || !hashCode) {
        throw new Error("Chưa cấu hình ONEPAY_MERCHANT/ONEPAY_ACCESS_CODE/ONEPAY_HASH_CODE trên server");
    }

    return { merchant, accessCode, hashCode };
}

// ==========================================
// KÝ THAM SỐ vpc_SecureHash (tài liệu mục II-4.4)
// ------------------------------------------
// Lấy mọi tham số vpc_/user_ (trừ vpc_SecureHash*), bỏ giá trị rỗng, sắp xếp
// key theo thứ tự phân biệt hoa/thường, nối "key=value" bằng "&" với giá trị
// GỐC (không encode URL), rồi HMAC-SHA256, hex IN HOA.
//
// LƯU Ý: tài liệu viết "Secret Key convert sang UTF-8 bytes", nhưng đối chiếu
// với ví dụ trong chính tài liệu (TESTMERCHANT, trang 20) thì khoá HMAC phải là
// HashCode GIẢI MÃ TỪ HEX (Buffer.from(hashCode, "hex")) — cách UTF-8 ra chữ
// ký khác. (Chuỗi mẫu trong tài liệu còn bị rớt 1 ký tự.) Đừng "sửa" lại.
// ==========================================

function buildSignData(params) {

    return Object.keys(params)
        .filter((key) =>
            (key.startsWith("vpc_") || key.startsWith("user_")) &&
            key !== "vpc_SecureHash" &&
            key !== "vpc_SecureHashType" &&
            params[key] !== undefined && params[key] !== null && params[key] !== ""
        )
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&");
}

function signParams(params, hashCode) {

    return crypto
        .createHmac("sha256", Buffer.from(hashCode, "hex"))
        .update(buildSignData(params), "utf8")
        .digest("hex")
        .toUpperCase();
}

function verifyParams(params, hashCode) {

    const received = String(params.vpc_SecureHash || "").toUpperCase();
    const expected = signParams(params, hashCode);

    if (!received || received.length !== expected.length) {
        return false;
    }

    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

// vpc_TicketNo = IP khách, tối đa 15 ký tự (IPv4). IPv6/không đọc được thì
// rơi về IP mặc định — vẫn hợp lệ về mặt định dạng.
function toIpv4(ip) {

    const v4 = String(ip || "").replace(/^::ffff:/, "");

    return /^\d{1,3}(\.\d{1,3}){3}$/.test(v4) ? v4 : "127.0.0.1";
}

// ==========================================
// TẠO ĐƠN + URL THANH TOÁN ONEPAY CHO MỘT HOLD
// ------------------------------------------
// Mirror createVnpayPaymentForHold: giá luôn tính lại từ Firestore (không tin
// số tiền client), coupon giữ chỗ atomic. OnePay KHÔNG có tham số hết hạn như
// expiredAt của PayOS — phiên thanh toán sống theo timeout phía OnePay (cấu hình
// theo merchant, cần nhờ OnePay đặt ~10 phút khớp thời gian giữ ghế). Khách trả
// muộn sau khi hold hết hạn đi vào luồng sẵn có của finalizeOrderAsPaid
// (conflict_needs_review) hoặc cảnh báo hoàn tiền trong processOnepayResult.
// ==========================================

async function createOnepayPaymentForHold({
    holdId,
    customerName,
    customerPhone,
    customerEmail,
    couponCode,
    ipAddr,
    locale,
    termsAccepted
}) {

    if (!holdId || !customerName || !customerPhone || !customerEmail) {
        throw new Error("Thiếu thông tin tạo thanh toán");
    }

    // Quy định tổ chức thẻ quốc tế (OnePay mục III-5): khách phải bấm đồng ý điều
    // khoản thanh toán trước khi sang cổng. Server từ chối nếu thiếu và ghi lại thời điểm.
    if (termsAccepted !== true) {
        throw new Error("Vui lòng đọc và đồng ý với điều khoản thanh toán");
    }

    if (ONEPAY_CURRENCY !== "VND") {
        // Merchant gán USD thì phải tự quy đổi tỷ giá (tài liệu mục III-4) — chưa làm.
        throw new Error("OnePay: chưa hỗ trợ tiền tệ khác VND");
    }

    const { merchant, accessCode, hashCode } = getCreds();

    const hold = await getHoldStatus(holdId);

    if (hold.status !== "ACTIVE") {
        throw new Error("Phiên giữ ghế không còn hiệu lực, vui lòng chọn ghế lại");
    }

    const showtimeRef = db
        .collection("shows")
        .doc(hold.showId)
        .collection("showtimes")
        .doc(hold.showtimeId);

    const seatDocs = await Promise.all(
        hold.seatIds.map((seatId) => showtimeRef.collection("seats").doc(seatId).get())
    );

    let subtotal = 0;

    seatDocs.forEach((doc, i) => {

        if (!doc.exists) {
            throw new Error(`Ghế ${hold.seatIds[i]} không tồn tại`);
        }

        subtotal += doc.data().price;
    });

    let amount = subtotal;
    let coupon = null;

    if (couponCode) {
        const applied = await reserveCouponToAmount(couponCode, subtotal);
        amount = applied.amount;
        coupon = {
            code: applied.code,
            percentOff: applied.percentOff,
            discount: applied.discount
        };
    }

    const orderCode = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const orderId = `order_${crypto.randomUUID()}`;
    const orderRef = db.collection("orders").doc(orderId);
    const onepayTxnRef = String(orderCode); // <= 40 ký tự, chỉ chữ số

    const now = new Date();

    await orderRef.set({
        holdId,

        showId: hold.showId,
        showtimeId: hold.showtimeId,
        seatIds: hold.seatIds,

        orderCode,
        onepayTxnRef,
        subtotal,
        amount,
        coupon,

        customerName,
        customerPhone,
        customerEmail,

        paymentProvider: "onepay",
        termsAcceptedAt: now,
        orderStatus: "PENDING_PAYMENT",
        paymentStatus: "PENDING",

        createdAt: now,
        updatedAt: now
    });

    // Coupon giảm 100% — không có gì để thanh toán, chốt PAID ngay.
    if (amount === 0) {
        await finalizeOrderAsPaid(orderRef);

        return { orderId, orderCode, subtotal, amount, coupon, free: true, paymentUrl: null };
    }

    const params = {
        vpc_Version: "2",
        vpc_Currency: ONEPAY_CURRENCY,
        vpc_Command: "pay",
        vpc_AccessCode: accessCode,
        vpc_Merchant: merchant,
        vpc_Locale: locale === "en" ? "en" : "vn",
        vpc_ReturnURL: `${BACKEND_URL}/api/payments/onepay/return`,
        vpc_CallbackURL: `${BACKEND_URL}/api/payments/onepay/ipn`,
        vpc_MerchTxnRef: onepayTxnRef,
        vpc_OrderInfo: `LumiShow ${onepayTxnRef}`, // <= 34 ký tự, không dấu/ký tự đặc biệt
        vpc_Amount: String(Math.round(amount) * 100), // luôn nhân 100, kể cả VND
        vpc_TicketNo: toIpv4(ipAddr),
        vpc_CardList: ONEPAY_CARD_LIST
    };

    params.vpc_SecureHash = signParams(params, hashCode);

    const query = Object.entries(params)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join("&");

    return {
        orderId,
        orderCode,
        subtotal,
        amount,
        coupon,
        free: false,
        paymentUrl: `${ONEPAY_PAYMENT_URL}?${query}`
    };
}

// ==========================================
// XỬ LÝ KẾT QUẢ (dùng chung cho ReturnURL, IPN và QueryDR)
// ------------------------------------------
// Thứ tự kiểm tra theo tài liệu: chữ ký → đơn tồn tại → số tiền khớp → trạng
// thái đơn (idempotent) → mã kết quả. Trả { ok, code, order? }:
//   code: INVALID_SIGNATURE | NOT_FOUND | AMOUNT_MISMATCH | PAID | FAILED |
//         PENDING | IGNORED (đơn đã đóng, không đổi gì)
// KHÔNG BAO GIỜ hạ một đơn đã PAID xuống thất bại (IPN-04 trong test case).
// ==========================================

async function processOnepayResult(params, source) {

    const { hashCode } = getCreds();

    const txnRef = params.vpc_MerchTxnRef ? String(params.vpc_MerchTxnRef) : null;
    const responseCode = params.vpc_TxnResponseCode === undefined ? null : String(params.vpc_TxnResponseCode);
    const verified = verifyParams(params, hashCode);

    // Nhật ký đối soát/nghiệm thu (chỉ field cần thiết, không lưu số thẻ).
    await db.collection("onepayIpnLogs").add({
        source,
        txnRef,
        responseCode,
        amount: params.vpc_Amount || null,
        transactionNo: params.vpc_TransactionNo || null,
        verified,
        receivedAt: new Date()
    }).catch((error) => console.error("ONEPAY LOG ERROR:", error));

    // Chữ ký sai/thiếu: KHÔNG đụng đơn (giữ pending, hỏi QueryDR sau) — chống URL giả.
    if (!verified) {
        return { ok: false, code: "INVALID_SIGNATURE" };
    }

    if (!txnRef) {
        return { ok: false, code: "NOT_FOUND" };
    }

    const snap = await db.collection("orders")
        .where("onepayTxnRef", "==", txnRef)
        .limit(1)
        .get();

    if (snap.empty) {
        return { ok: false, code: "NOT_FOUND" };
    }

    const orderRef = snap.docs[0].ref;
    const order = snap.docs[0].data();
    const orderId = snap.docs[0].id;

    if (order.orderStatus === "PAID") {
        return { ok: true, code: "PAID", orderId };
    }

    // Chỉ coi là thành công khi đúng chuỗi "0" (OnePay có mã chữ F/Z... — không ép kiểu).
    if (responseCode === "0") {

        // Số tiền phải khớp đơn mới được cấp vé (tài liệu: điều kiện để coi là thành công).
        // Giao dịch thất bại/hết hạn không có vpc_Amount nên chỉ kiểm tra ở nhánh này.
        const paidAmount = Number(params.vpc_Amount) / 100;

        if (!Number.isFinite(paidAmount) || paidAmount !== Number(order.amount)) {
            console.error(`ONEPAY: lệch số tiền đơn ${orderId} — nhận ${params.vpc_Amount}, đơn ${order.amount}`);
            return { ok: false, code: "AMOUNT_MISMATCH", orderId };
        }

        await finalizeOrderAsPaid(orderRef, paidAmount);

        const after = (await orderRef.get()).data();

        if (after.orderStatus !== "PAID") {
            // Tiền đã vào nhưng đơn đã CANCELLED/EXPIRED (khách bấm huỷ rồi vẫn trả,
            // hoặc OnePay trả muộn) hoặc trả thiếu → cần hoàn tay, không tự cấp vé.
            await orderRef.update({
                onepayPaidNotFinalized: true,
                onepayTransactionNo: params.vpc_TransactionNo || null,
                updatedAt: new Date()
            });

            console.error(`ONEPAY: ĐÃ NHẬN TIỀN nhưng đơn ${orderId} đang ${after.orderStatus}/${after.paymentStatus} — cần hoàn tiền tay`);

            await sendTechAlertEmail(
                `⚠️ OnePay: đã nhận tiền nhưng đơn #${order.orderCode} không xuất vé được`,
                `Đơn ${orderId} (mã ${order.orderCode}) — khách ${order.customerName} / ${order.customerPhone}\n` +
                `OnePay xác nhận đã thu ${paidAmount}đ (mã GD OnePay ${params.vpc_TransactionNo || "?"}) ` +
                `nhưng đơn đang ở trạng thái ${after.orderStatus}/${after.paymentStatus} nên KHÔNG cấp vé.\n` +
                `Cần kiểm tra và hoàn tiền / xử lý tay.`
            ).catch((error) => console.error("ONEPAY ALERT EMAIL ERROR:", error));

            return { ok: true, code: "PAID_NOT_FINALIZED", orderId };
        }

        await orderRef.update({
            onepayTransactionNo: params.vpc_TransactionNo || null,
            onepayCard: params.vpc_Card || null,
            updatedAt: new Date()
        });

        return { ok: true, code: "PAID", orderId };
    }

    // Thiếu mã kết quả / 100 / 300 = chưa có kết quả cuối — để nguyên, QueryDR hỏi tiếp.
    if (responseCode === null || responseCode === "100" || responseCode === "300") {
        return { ok: true, code: "PENDING", orderId };
    }

    // Thất bại cuối cùng (từ chối thẻ, 99 khách huỷ, 253 hết hạn...). Chỉ đóng đơn
    // đang chờ thanh toán; nhả lượt coupon. Hold giữ nguyên tới khi hết hạn để
    // khách còn thử lại bằng thẻ khác.
    let cancelled = false;

    await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(orderRef);

        if (fresh.data().orderStatus !== "PENDING_PAYMENT") {
            return;
        }

        transaction.update(orderRef, {
            orderStatus: "CANCELLED",
            paymentStatus: "FAILED",
            onepayResponseCode: responseCode,
            updatedAt: new Date()
        });
        cancelled = true;
    });

    if (cancelled && order.coupon && order.coupon.code) {
        await releaseCouponUse(order.coupon.code).catch(() => {});
    }

    return { ok: true, code: cancelled ? "FAILED" : "IGNORED", orderId, responseCode };
}

// ==========================================
// QUERYDR — hỏi thẳng OnePay trạng thái 1 giao dịch (tài liệu mục II-5)
// Dùng khi ReturnURL/IPN không về (khách đóng tab, mất mạng, IPN lỗi).
// Trả params phản hồi đã kèm cờ `verified`; DRExists=N → { exists:false }.
// ==========================================

async function queryOnepay(txnRef) {

    const { merchant, accessCode, hashCode } = getCreds();
    const user = process.env.ONEPAY_QUERY_USER;
    const password = process.env.ONEPAY_QUERY_PASSWORD;

    if (!user || !password) {
        throw new Error("Chưa cấu hình ONEPAY_QUERY_USER/ONEPAY_QUERY_PASSWORD (QueryDR)");
    }

    const params = {
        vpc_Command: "queryDR",
        vpc_Version: "2",
        vpc_MerchTxnRef: String(txnRef),
        vpc_Merchant: merchant,
        vpc_AccessCode: accessCode,
        vpc_User: user,
        vpc_Password: password
    };

    params.vpc_SecureHash = signParams(params, hashCode);

    const response = await fetch(ONEPAY_QUERY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        throw new Error(`OnePay QueryDR lỗi HTTP ${response.status}`);
    }

    const result = Object.fromEntries(new URLSearchParams(await response.text()));

    return {
        exists: result.vpc_DRExists === "Y",
        verified: verifyParams(result, hashCode),
        result
    };
}

// Hỏi QueryDR rồi áp kết quả lên đơn bằng chính processOnepayResult. Trả
// { state: "PAID" | "FAILED" | "PENDING" | "NOT_FOUND" } cho reconcile/status.
async function syncOnepayOrder(order) {

    const { exists, verified, result } = await queryOnepay(order.onepayTxnRef);

    if (!exists) {
        return { state: "NOT_FOUND" };
    }

    if (!verified) {
        console.error(`ONEPAY QueryDR: chữ ký phản hồi sai — ${order.onepayTxnRef}`);
        return { state: "PENDING" };
    }

    const outcome = await processOnepayResult(result, "querydr");

    if (outcome.code === "PAID" || outcome.code === "PAID_NOT_FINALIZED") {
        return { state: "PAID", amountPaid: Number(result.vpc_Amount) / 100 };
    }

    if (outcome.code === "FAILED" || outcome.code === "IGNORED") {
        return { state: "FAILED" };
    }

    return { state: "PENDING" };
}

// ==========================================
// ĐỌC TRẠNG THÁI ĐƠN ONEPAY (frontend poll sau khi khách quay về)
// ------------------------------------------
// Đọc Firestore; nếu đơn còn PENDING_PAYMENT thì hỏi QueryDR (giới hạn 1 lần/
// 8 giây/đơn để không dội OnePay khi nhiều tab poll).
// ponytail: throttle bằng Map trong bộ nhớ — đủ cho 1 instance Render; nếu
// scale nhiều instance thì chuyển sang field Firestore.
// ==========================================

const lastQueryAt = new Map();
const QUERY_THROTTLE_MS = 8000;

async function getOnepayOrderStatus(orderId) {

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
        throw new Error("Không tìm thấy đơn hàng");
    }

    let order = orderSnap.data();

    if (order.orderStatus === "PENDING_PAYMENT" && order.paymentProvider === "onepay") {

        const last = lastQueryAt.get(orderId) || 0;

        if (Date.now() - last >= QUERY_THROTTLE_MS) {
            lastQueryAt.set(orderId, Date.now());

            try {
                await syncOnepayOrder(order);
                order = (await orderRef.get()).data();
            } catch (error) {
                console.error("ONEPAY STATUS QUERYDR ERROR:", error.message);
            }
        }
    }

    return {
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus
    };
}

// Tra orderId theo mã giao dịch (CHỈ để điều hướng khách về trang đặt vé khi
// chữ ký ReturnURL sai — không tin dữ liệu, trạng thái thật vẫn do QueryDR quyết).
async function findOrderIdByTxnRef(txnRef) {

    if (!txnRef) {
        return null;
    }

    const snap = await db.collection("orders")
        .where("onepayTxnRef", "==", String(txnRef))
        .limit(1)
        .get();

    return snap.empty ? null : snap.docs[0].id;
}

// URL đưa khách về trang đặt vé sau khi OnePay trả kết quả qua ReturnURL.
function buildFrontendReturnUrl(orderId, code) {

    const query = new URLSearchParams({ onepayReturn: "1", result: code });

    if (orderId) {
        query.set("orderId", orderId);
    }

    return `${FRONTEND_URL}/dat-ve.html?${query.toString()}`;
}

module.exports = {
    createOnepayPaymentForHold,
    processOnepayResult,
    queryOnepay,
    syncOnepayOrder,
    getOnepayOrderStatus,
    buildFrontendReturnUrl,
    findOrderIdByTxnRef,
    // chỉ để test chữ ký
    signParams
};
