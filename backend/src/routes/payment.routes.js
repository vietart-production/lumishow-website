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
// GET /api/payments/:orderId/status?provider=vnpay
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
