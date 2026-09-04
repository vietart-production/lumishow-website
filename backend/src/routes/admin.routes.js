const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const {
    checkPin,
    cancelTicketBySeat,
    createManualTicket
} = require("../services/admin.service");

// Giới hạn chặt — đây là endpoint nhạy cảm nhất hệ thống (huỷ/tạo vé bằng
// tay), PIN chỉ 7 số nên cần chặn dò mật khẩu tích cực hơn rate-limit chung.
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 phút
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Quá nhiều yêu cầu, vui lòng thử lại sau."
    }
});

router.use("/admin", adminLimiter);

function requirePin(req, res, next) {
    if (!checkPin(req.body.password)) {
        return res.status(401).json({
            success: false,
            message: "Sai mật khẩu admin"
        });
    }
    next();
}

// ==========================================
// POST /api/admin/verify-pin
// Chỉ để app hiện menu admin sau khi nhập đúng — không tự làm gì thêm.
// ==========================================

router.post("/admin/verify-pin", requirePin, (req, res) => {
    return res.status(200).json({ success: true });
});

// ==========================================
// POST /api/admin/tickets/cancel
// body: { password, showId, showtimeId, seatId }
// ==========================================

router.post("/admin/tickets/cancel", requirePin, async (req, res) => {

    try {

        const { showId, showtimeId, seatId } = req.body;

        const result = await cancelTicketBySeat({ showId, showtimeId, seatId });

        return res.status(200).json({
            success: true,
            message: "Đã huỷ vé, ghế đã trả về trạng thái trống",
            ticket: result
        });

    } catch (error) {

        console.error("ADMIN CANCEL TICKET ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể huỷ vé"
        });
    }
});

// ==========================================
// POST /api/admin/tickets/create
// body: { password, showId, showtimeId, seatId, customerName, customerPhone, customerEmail }
// ==========================================

router.post("/admin/tickets/create", requirePin, async (req, res) => {

    try {

        const {
            showId,
            showtimeId,
            seatId,
            customerName,
            customerPhone,
            customerEmail
        } = req.body;

        const result = await createManualTicket({
            showId,
            showtimeId,
            seatId,
            customerName,
            customerPhone,
            customerEmail
        });

        return res.status(201).json({
            success: true,
            message: "Đã tạo vé thủ công",
            ticket: result
        });

    } catch (error) {

        console.error("ADMIN CREATE TICKET ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể tạo vé"
        });
    }
});

module.exports = router;
