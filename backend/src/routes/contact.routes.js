const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const { sendContactEmail } = require("../services/email.service");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Giới hạn riêng cho form liên hệ — mỗi lần submit là 1 lệnh gọi Resend thật
const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 giờ
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Bạn đã gửi liên hệ quá nhiều lần. Vui lòng thử lại sau."
    }
});

// ==========================================
// POST /api/contact
// Nhận thông tin từ biểu mẫu "Liên hệ" và gửi mail về hộp thư công ty
// ==========================================

router.post("/contact", contactLimiter, async (req, res) => {

    try {

        const {
            name,
            phone,
            email,
            company,
            message
        } = req.body;

        if (!name || !phone || !email || !message) {
            return res.status(400).json({
                success: false,
                message: "Vui lòng điền đầy đủ họ tên, số điện thoại, email và nội dung."
            });
        }

        if (!EMAIL_REGEX.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Email không hợp lệ."
            });
        }

        await sendContactEmail({
            name: String(name).trim(),
            phone: String(phone).trim(),
            email: String(email).trim(),
            company: company ? String(company).trim() : "",
            message: String(message).trim()
        });

        return res.status(200).json({
            success: true,
            message: "Đã gửi thông tin liên hệ thành công"
        });

    } catch (error) {

        console.error(
            "CONTACT FORM ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Không thể gửi thông tin liên hệ, vui lòng thử lại sau."
        });

    }

});

module.exports = router;
