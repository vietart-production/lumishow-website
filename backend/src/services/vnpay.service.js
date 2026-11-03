const path = require("path");

require("dotenv").config({
    path: path.resolve(__dirname, "../../.env")
});

const crypto = require("crypto");

const { db } = require("../config/firebase");
const { getHoldStatus } = require("./booking.service");
const { reserveCouponToAmount, releaseCouponUse } = require("./coupon.service");
const { finalizeOrderAsPaid } = require("./payment.service");

const VNPAY_TMN_CODE = process.env.VNPAY_TMN_CODE;
const VNPAY_HASH_SECRET = process.env.VNPAY_HASH_SECRET;
const VNPAY_PAYMENT_URL = process.env.VNPAY_PAYMENT_URL || "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://127.0.0.1:5500";

// IP VNPay gọi IPN về — theo đúng danh sách VNPay cung cấp (sandbox + production
// gộp chung vì cùng 1 server chạy, chỉ khác bộ TMN_CODE/HASH_SECRET đang cấu hình).
// Theo yêu cầu bảo mật của VNPay: chặn IPN gọi từ IP lạ.
const VNPAY_IPN_ALLOWED_IPS = new Set([
    // sandbox
    "113.160.92.202",
    "203.205.17.226",
    "103.220.84.4",
    // production
    "113.52.45.78",
    "116.97.245.130",
    "42.118.107.252",
    "113.20.97.250",
    "203.171.19.146",
    "103.220.87.4",
    "103.220.86.4",
    "103.220.86.10",
    "103.220.87.10",
    "103.220.86.139",
    "103.220.87.139"
]);


// ==========================================
// GIỜ GMT+7 dạng yyyyMMddHHmmss (VNPay yêu cầu đúng định dạng này) — tính
// từ epoch nên không phụ thuộc timezone của server chạy Node (Render chạy UTC).
// ==========================================

function vnpDateFormat(date) {

    const shifted = new Date(date.getTime() + 7 * 60 * 60000);
    const pad = (n) => String(n).padStart(2, "0");

    return (
        shifted.getUTCFullYear() +
        pad(shifted.getUTCMonth() + 1) +
        pad(shifted.getUTCDate()) +
        pad(shifted.getUTCHours()) +
        pad(shifted.getUTCMinutes()) +
        pad(shifted.getUTCSeconds())
    );
}

// ==========================================
// KÝ THAM SỐ — thuật toán đúng theo sample chính thức VNPay (sort key tăng
// dần, encode từng value kiểu PHP urlencode tức encodeURIComponent nhưng
// đổi %20 thành dấu + , rồi HMAC-SHA512 trên chuỗi key=value&... đã encode).
// ==========================================

function sortAndEncodeParams(params) {

    const sorted = {};

    Object.keys(params)
        .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
        .sort()
        .forEach((key) => {
            sorted[key] = encodeURIComponent(String(params[key])).replace(/%20/g, "+");
        });

    return sorted;
}

function signParams(params) {

    const sorted = sortAndEncodeParams(params);
    const signData = Object.entries(sorted).map(([k, v]) => `${k}=${v}`).join("&");
    const hash = crypto
        .createHmac("sha512", VNPAY_HASH_SECRET)
        .update(Buffer.from(signData, "utf-8"))
        .digest("hex");

    return { signData, hash };
}

// ==========================================
// TẠO ĐƠN HÀNG + URL THANH TOÁN VNPAY CHO MỘT HOLD
// ------------------------------------------
// Mirror createPaymentForHold (payment.service.js, PayOS) — giá luôn tính
// lại từ Firestore, coupon giữ chỗ atomic. Khác biệt: thay vì gọi API tạo
// payment link, tự ký URL redirect theo đúng chuẩn VNPay.
// ==========================================

async function createVnpayPaymentForHold({
    holdId,
    customerName,
    customerPhone,
    customerEmail,
    couponCode,
    ipAddr
}) {

    if (!holdId || !customerName || !customerPhone || !customerEmail) {
        throw new Error("Thiếu thông tin tạo thanh toán");
    }

    if (!VNPAY_TMN_CODE || !VNPAY_HASH_SECRET) {
        throw new Error("Chưa cấu hình VNPAY_TMN_CODE/VNPAY_HASH_SECRET trên server");
    }

    const hold = await getHoldStatus(holdId);

    if (hold.status !== "ACTIVE") {
        throw new Error("Phiên giữ ghế không còn hiệu lực, vui lòng chọn ghế lại");
    }

    const showtimeRef = db
        .collection("shows")
        .doc(hold.showId)
        .collection("showtimes")
        .doc(hold.showtimeId);

    const seatRefs = hold.seatIds.map((seatId) =>
        showtimeRef
            .collection("seats")
            .doc(seatId)
    );

    const seatDocs = await Promise.all(
        seatRefs.map((ref) => ref.get())
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
    const vnpTxnRef = String(orderCode);

    const now = new Date();

    await orderRef.set({
        holdId,

        showId: hold.showId,
        showtimeId: hold.showtimeId,
        seatIds: hold.seatIds,

        orderCode,
        vnpTxnRef,
        subtotal,
        amount,
        coupon,

        customerName,
        customerPhone,
        customerEmail,

        paymentProvider: "vnpay",
        orderStatus: "PENDING_PAYMENT",
        paymentStatus: "PENDING",

        createdAt: now,
        updatedAt: now
    });

    // Coupon giảm 100% — không có gì để thanh toán qua VNPay, chốt PAID ngay
    // bằng đúng hàm transaction dùng chung với PayOS/IPN (không viết riêng).
    if (amount === 0) {
        await finalizeOrderAsPaid(orderRef);

        return {
            orderId,
            orderCode,
            subtotal,
            amount,
            coupon,
            free: true,
            paymentUrl: null
        };
    }

    const params = {
        vnp_Version: "2.1.0",
        vnp_Command: "pay",
        vnp_TmnCode: VNPAY_TMN_CODE,
        vnp_Amount: Math.round(amount) * 100,
        vnp_CurrCode: "VND",
        vnp_TxnRef: vnpTxnRef,
        vnp_OrderInfo: `Thanh toan don hang LumiShow ${vnpTxnRef}`,
        vnp_OrderType: "other",
        vnp_Locale: "vn",
        vnp_ReturnUrl: `${FRONTEND_URL}/dat-ve.html?vnpayReturn=1&orderId=${orderId}`,
        vnp_IpAddr: ipAddr || "127.0.0.1",
        vnp_CreateDate: vnpDateFormat(now)
    };

    const { signData, hash } = signParams(params);
    const paymentUrl = `${VNPAY_PAYMENT_URL}?${signData}&vnp_SecureHash=${hash}`;

    return {
        orderId,
        orderCode,
        subtotal,
        amount,
        coupon,
        free: false,
        paymentUrl
    };
}

// ==========================================
// IPN (VNPay gọi GET ngược về server khi có biến động thanh toán)
// ------------------------------------------
// Không tin bất kỳ field nào trước khi xác minh lại chữ ký. Luôn trả HTTP 200
// kèm RspCode đúng chuẩn VNPay (họ dựa vào RspCode để quyết định có retry
// IPN hay không, không phải HTTP status).
//
// Theo yêu cầu VNPay (kịch bản kiểm thử IPN/Return URL): chặn IP lạ + lưu lại
// toàn bộ IP + dữ liệu mỗi lần IPN gọi tới (ít nhất 2 tháng) để đối soát khi
// cần — ghi vào Firestore collection "vnpayIpnLogs", không có cơ chế tự xoá
// nên log giữ vĩnh viễn (an toàn hơn so với giới hạn 2 tháng yêu cầu).
// ==========================================

async function handleVnpayIpn(query, ip) {

    await db.collection("vnpayIpnLogs").add({
        ip: ip || null,
        query,
        receivedAt: new Date()
    }).catch((error) => console.error("VNPAY IPN LOG ERROR:", error));

    if (!VNPAY_IPN_ALLOWED_IPS.has(ip)) {
        console.warn(`VNPAY IPN: chặn IP lạ ngoài whitelist — ${ip}`);
        return { RspCode: "99", Message: "Unknow error" };
    }

    const received = { ...query };
    const receivedHash = received.vnp_SecureHash;

    delete received.vnp_SecureHash;
    delete received.vnp_SecureHashType;

    const { hash } = signParams(received);

    if (!receivedHash || hash.toLowerCase() !== String(receivedHash).toLowerCase()) {
        return { RspCode: "97", Message: "Invalid signature" };
    }

    const vnpTxnRef = received.vnp_TxnRef;

    const ordersSnapshot = await db
        .collection("orders")
        .where("vnpTxnRef", "==", vnpTxnRef)
        .limit(1)
        .get();

    if (ordersSnapshot.empty) {
        return { RspCode: "01", Message: "Order not found" };
    }

    const orderRef = ordersSnapshot.docs[0].ref;
    const order = ordersSnapshot.docs[0].data();

    const vnpAmount = Number(received.vnp_Amount) / 100;

    if (vnpAmount !== Number(order.amount)) {
        return { RspCode: "04", Message: "Invalid amount" };
    }

    if (order.orderStatus === "PAID") {
        return { RspCode: "02", Message: "Order already confirmed" };
    }

    if (received.vnp_ResponseCode === "00" && received.vnp_TransactionStatus === "00") {

        await finalizeOrderAsPaid(orderRef, vnpAmount);

    } else {

        await orderRef.update({
            orderStatus: "CANCELLED",
            paymentStatus: "FAILED",
            vnpResponseCode: received.vnp_ResponseCode || null,
            updatedAt: new Date()
        });

        if (order.coupon && order.coupon.code) {
            await releaseCouponUse(order.coupon.code).catch(() => {});
        }
    }

    return { RspCode: "00", Message: "Confirm Success" };
}

// ==========================================
// ĐỌC TRẠNG THÁI ĐƠN VNPAY — IPN đã cập nhật thẳng vào Firestore nên chỉ
// cần đọc lại order, không cần hỏi ngược VNPay (khác PayOS chưa có domain
// đăng ký webhook nên phải tự poll). Nếu sau này phát hiện IPN bị trễ/mất
// (Render ngủ đông — xem ghi chú C6 trong CLAUDE.md) thì bổ sung gọi API
// querydr làm phương án dự phòng, tương tự getPaymentStatus() của PayOS.
// ==========================================

async function getVnpayOrderStatus(orderId) {

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
        throw new Error("Không tìm thấy đơn hàng");
    }

    const order = orderSnap.data();

    return {
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus
    };
}

module.exports = {
    createVnpayPaymentForHold,
    handleVnpayIpn,
    getVnpayOrderStatus
};
