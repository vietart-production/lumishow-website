const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const { checkPin } = require("../services/admin.service");
const { getSeatStates } = require("../services/booking.service");
const {
    TEST_SHOW_ID,
    ensureTestShowtime,
    resetTestShowtime,
    createTestTicket,
    listTestTicketHistory
} = require("../services/testerTicket.service");

// ==========================================
// "TESTER TICKET" (frontend/tester-ticket.html) — công cụ nội bộ cho tester
// đặt vé ảo lấy QR thật để quét thử app soát vé, không đụng dữ liệu show
// thật (xem testerTicket.service.js cho toàn bộ cơ chế cách ly). Router này
// KHÔNG dùng chung middleware (rate limit/activity log) của admin.routes.js
// — 2 router Express mount cùng "/api" không tự chia sẻ .use() của nhau, nên
// tự khai riêng 1 limiter nhẹ ở đây. Không ghi vào adminActivityLog để không
// lẫn noise test vào log thao tác admin thật.
// ==========================================

const testerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
        success: false,
        message: "Quá nhiều yêu cầu, vui lòng thử lại sau."
    }
});

router.use("/tester-ticket", testerLimiter);

function requirePin(req, res, next) {
    if (!checkPin(req.body.password)) {
        return res.status(401).json({
            success: false,
            message: "Sai mật khẩu admin"
        });
    }
    next();
}

router.post("/tester-ticket/verify-pin", requirePin, (req, res) => {
    return res.status(200).json({ success: true });
});

// POST /api/tester-ticket/seats  body: { password }
router.post("/tester-ticket/seats", requirePin, async (req, res) => {
    try {
        const showtimeId = await ensureTestShowtime();
        const seats = await getSeatStates(TEST_SHOW_ID, showtimeId);
        return res.status(200).json({ success: true, showtimeId, seats });
    } catch (error) {
        console.error("TESTER TICKET SEATS ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể tải sơ đồ ghế test" });
    }
});

// POST /api/tester-ticket/reset  body: { password }
router.post("/tester-ticket/reset", requirePin, async (req, res) => {
    try {
        const showtimeId = await resetTestShowtime();
        return res.status(200).json({ success: true, message: "Đã reset toàn bộ ghế suất test", showtimeId });
    } catch (error) {
        console.error("TESTER TICKET RESET ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể reset suất test" });
    }
});

// POST /api/tester-ticket/create  body: { password, seatIds, customerEmail }
router.post("/tester-ticket/create", requirePin, async (req, res) => {
    try {
        const { seatIds, customerEmail } = req.body;
        const result = await createTestTicket({ seatIds, customerEmail });
        return res.status(201).json({ success: true, ...result });
    } catch (error) {
        console.error("TESTER TICKET CREATE ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể tạo vé test" });
    }
});

// POST /api/tester-ticket/history  body: { password, limit? }
router.post("/tester-ticket/history", requirePin, async (req, res) => {
    try {
        const history = await listTestTicketHistory({ limit: req.body.limit });
        return res.status(200).json({ success: true, history });
    } catch (error) {
        console.error("TESTER TICKET HISTORY ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể lấy lịch sử vé test" });
    }
});

module.exports = router;
