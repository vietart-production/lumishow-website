const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const {
    createPaymentForHold,
    handlePaymentWebhook,
    getPaymentStatus
} = require("../services/payment.service");

const {
    createVnpayPaymentForHold,
    handleVnpayIpn,
    getVnpayOrderStatus
} = require("../services/vnpay.service");

const {
    createOnepayPaymentForHold,
    processOnepayResult,
    getOnepayOrderStatus,
    buildFrontendReturnUrl,
    findOrderIdByTxnRef
} = require("../services/onepay.service");

// Giới hạn số lần tạo payment link — mỗi lần tạo là 1 lệnh gọi PayOS thật
const paymentLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 giờ
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Bạn đã thử tạo thanh toán quá nhiều lần. Vui lòng thử lại sau."
    }
});

// ==========================================
// POST /api/payments/create
// Tạo đơn hàng + payment link PayOS cho một hold đang ACTIVE
// ==========================================

router.post("/payments/create", paymentLimiter, async (req, res) => {

    try {

        const {
            holdId,
            customerName,
            customerPhone,
            customerEmail,
            couponCode
        } = req.body;

        const result = await createPaymentForHold({
            holdId,
            customerName,
            customerPhone,
            customerEmail,
            couponCode
        });

        return res.status(201).json({
            success: true,
            order: result
        });

    } catch (error) {

        console.error(
            "CREATE PAYMENT ERROR:",
            error
        );

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể tạo thanh toán"
        });

    }

});

// ==========================================
// POST /api/payments/vnpay/create
// Tạo đơn hàng + URL thanh toán VNPay (thẻ Visa/Mastercard/JCB, QR) cho
// một hold đang ACTIVE — song song với /payments/create (PayOS), không
// thay thế.
// ==========================================

router.post("/payments/vnpay/create", paymentLimiter, async (req, res) => {

    try {

        const {
            holdId,
            customerName,
            customerPhone,
            customerEmail,
            couponCode
        } = req.body;

        const result = await createVnpayPaymentForHold({
            holdId,
            customerName,
            customerPhone,
            customerEmail,
            couponCode,
            ipAddr: req.ip
        });

        return res.status(201).json({
            success: true,
            order: result
        });

    } catch (error) {

        console.error(
            "CREATE VNPAY PAYMENT ERROR:",
            error
        );

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể tạo thanh toán VNPay"
        });

    }

});

// ==========================================
// GET /api/payments/vnpay/ipn
// VNPay gọi ngược GET về server khi có biến động thanh toán. LUÔN trả HTTP
// 200 kèm RspCode đúng chuẩn — VNPay dựa vào RspCode (không phải HTTP
// status) để quyết định có retry IPN hay không.
// ==========================================

router.get("/payments/vnpay/ipn", async (req, res) => {

    try {

        // Render đứng sau Cloudflare — req.ip (trust proxy) lấy nhầm IP edge
        // Cloudflare cuối chuỗi X-Forwarded-For thay vì IP gốc thật. Cloudflare
        // luôn set CF-Connecting-IP = IP gốc thật, ưu tiên header này trước.
        const realIp = req.headers["cf-connecting-ip"] || req.ip;

        const result = await handleVnpayIpn(req.query, realIp, {
            xForwardedFor: req.headers["x-forwarded-for"] || null,
            cfConnectingIp: req.headers["cf-connecting-ip"] || null,
            xRealIp: req.headers["x-real-ip"] || null,
            reqIps: req.ips
        });
        return res.status(200).json(result);

    } catch (error) {

        console.error(
            "VNPAY IPN ERROR:",
            error
        );

        return res.status(200).json({ RspCode: "99", Message: "Unknow error" });

    }

});

// ==========================================
// POST /api/payments/onepay/create
// Tạo đơn + URL thanh toán thẻ quốc tế OnePay cho một hold đang ACTIVE —
// song song với /payments/create (PayOS) và /payments/vnpay/create.
// ==========================================

router.post("/payments/onepay/create", paymentLimiter, async (req, res) => {

    try {

        const {
            holdId,
            customerName,
            customerPhone,
            customerEmail,
            couponCode,
            locale,
            termsAccepted
        } = req.body;

        const result = await createOnepayPaymentForHold({
            holdId,
            customerName,
            customerPhone,
            customerEmail,
            couponCode,
            locale,
            termsAccepted,
            // Render đứng sau Cloudflare — ưu tiên CF-Connecting-IP (IP gốc thật).
            ipAddr: req.headers["cf-connecting-ip"] || req.ip
        });

        return res.status(201).json({
            success: true,
            order: result
        });

    } catch (error) {

        console.error(
            "CREATE ONEPAY PAYMENT ERROR:",
            error
        );

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể tạo thanh toán OnePay"
        });

    }

});

// ==========================================
// GET|POST /api/payments/onepay/ipn
// OnePay gọi server-to-server (GET query hoặc POST form-urlencoded). Trả đúng
// chuẩn OnePay: HTTP 200 + "responsecode=1&desc=confirm-success" khi đã ghi
// nhận; khác 200 + "responsecode=0&desc=confirm-fail" để OnePay retry (3 lần,
// cách 50s). Chữ ký sai/không thấy đơn/lệch tiền: trả fail (400), KHÔNG đổi đơn.
// ==========================================

async function onepayIpn(req, res) {

    res.type("text/plain");

    try {

        const params = req.method === "POST" ? req.body : req.query;
        const outcome = await processOnepayResult(params || {}, "ipn");

        if (outcome.ok) {
            return res.status(200).send("responsecode=1&desc=confirm-success");
        }

        return res.status(400).send("responsecode=0&desc=confirm-fail");

    } catch (error) {

        console.error("ONEPAY IPN ERROR:", error);

        return res.status(500).send("responsecode=0&desc=confirm-fail");

    }

}

router.get("/payments/onepay/ipn", onepayIpn);
router.post("/payments/onepay/ipn", express.urlencoded({ extended: false }), onepayIpn);

// ==========================================
// GET /api/payments/onepay/return
// ReturnURL: OnePay chuyển TRÌNH DUYỆT khách về đây kèm kết quả. Query này
// khách sửa được → luôn xác minh chữ ký trước khi tin (processOnepayResult),
// rồi 302 về trang đặt vé; trang đó chỉ hiển thị theo trạng thái đơn thật từ
// /payments/:orderId/status?provider=onepay, không tin tham số trên URL.
// ==========================================

router.get("/payments/onepay/return", async (req, res) => {

    try {

        const outcome = await processOnepayResult(req.query, "return");

        const orderId = outcome.orderId || await findOrderIdByTxnRef(req.query.vpc_MerchTxnRef);

        return res.redirect(302, buildFrontendReturnUrl(orderId, outcome.code));

    } catch (error) {

        console.error("ONEPAY RETURN ERROR:", error);

        return res.redirect(302, buildFrontendReturnUrl(null, "ERROR"));

    }

});

// ==========================================
// POST /api/payments/webhook
// PayOS gọi endpoint này khi có biến động thanh toán
// ==========================================

router.post("/payments/webhook", async (req, res) => {

    try {

        const result = await handlePaymentWebhook(req.body);

        return res.status(200).json({
            success: true,
            ...result
        });

    } catch (error) {

        console.error(
            "PAYMENT WEBHOOK ERROR:",
            error
        );

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể xử lý webhook"
        });

    }

});

// ==========================================
// GET /api/payments/:orderId/status?provider=vnpay|onepay
// Hỏi trạng thái đơn. Mặc định (PayOS): hỏi thẳng PayOS, dùng để frontend
// poll trong lúc chưa có domain đăng ký webhook. Với đơn VNPay
// (?provider=vnpay): IPN đã cập nhật thẳng Firestore nên chỉ cần đọc lại,
// không cần hỏi ngược VNPay.
// ==========================================

router.get("/payments/:orderId/status", async (req, res) => {

    try {

        const { orderId } = req.params;

        const result = req.query.provider === "vnpay"
            ? await getVnpayOrderStatus(orderId)
            : req.query.provider === "onepay"
                ? await getOnepayOrderStatus(orderId)
                : await getPaymentStatus(orderId);

        return res.status(200).json({
            success: true,
            ...result
        });

    } catch (error) {

        console.error(
            "GET PAYMENT STATUS ERROR:",
            error
        );

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể kiểm tra trạng thái thanh toán"
        });

    }

});

module.exports = router;
