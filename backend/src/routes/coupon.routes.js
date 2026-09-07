const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const { getCouponStatus } = require("../services/coupon.service");

// Endpoint dò-mã-được (nhập mã bất kỳ để thử) — cần giới hạn chặt hơn hẳn
// apiLimiter chung để chống brute-force dò mã giảm giá.
const couponLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 phút
    limit: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Bạn đã thử mã quá nhiều lần, vui lòng thử lại sau."
    }
});

// ==========================================
// POST /api/coupons/validate
// body: { code }
// Chỉ để hiện % giảm ngay khi khách bấm "Áp dụng" — KHÔNG tăng usedCount,
// KHÔNG phải bước tính tiền cuối cùng. Số tiền thật luôn được server tính
// lại (kèm validate lại coupon) ngay trong POST /api/payments/create.
// ==========================================

router.post("/coupons/validate", couponLimiter, async (req, res) => {

    try {

        const { code } = req.body;
        const result = await getCouponStatus(code);

        if (!result.valid) {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }

        return res.status(200).json({
            success: true,
            valid: true,
            code: result.code,
            percentOff: result.percentOff
        });

    } catch (error) {

        console.error("VALIDATE COUPON ERROR:", error);

        return res.status(400).json({
            success: false,
            message: "Không thể kiểm tra mã giảm giá."
        });
    }
});

module.exports = router;
