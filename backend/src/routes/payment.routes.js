const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const {
    createPaymentForHold,
    handlePaymentWebhook,
    getPaymentStatus
} = require("../services/payment.service");

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
            customerEmail
        } = req.body;

        const result = await createPaymentForHold({
            holdId,
            customerName,
            customerPhone,
            customerEmail
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
// GET /api/payments/:orderId/status
// Hỏi trạng thái đơn — dùng để frontend poll trong lúc chưa có domain
// đăng ký webhook. Hỏi thẳng PayOS, không cần PayOS gọi ngược lại.
// ==========================================

router.get("/payments/:orderId/status", async (req, res) => {

    try {

        const { orderId } = req.params;

        const result = await getPaymentStatus(orderId);

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
