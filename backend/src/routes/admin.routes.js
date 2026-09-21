const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const {
    checkPin,
    cancelTicketBySeat,
    createManualTicket,
    listUpcomingShowtimes,
    deleteOrder,
    updateOrderCustomerInfo,
    findOrderByCode,
    resendOrderTicketEmail,
    exchangePaidOrderTickets
} = require("../services/admin.service");
const { sendTicketEmail } = require("../services/email.service");

const SHOW_ID = "son-than-thuy-quai";

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
// POST /api/admin/showtimes/list
// body: { password }
// Trả về các suất diễn sắp tới (mùa diễn kéo dài nhiều tháng, mỗi ngày
// trong tuần giờ diễn khác nhau — xem seedSeats.js) để app Unity cho nhân
// viên chọn, không phải gõ tay showtimeId.
// ==========================================

router.post("/admin/showtimes/list", requirePin, async (req, res) => {

    try {

        const showtimes = await listUpcomingShowtimes({ showId: SHOW_ID, limit: 10 });

        return res.status(200).json({
            success: true,
            showtimes
        });

    } catch (error) {

        console.error("ADMIN LIST SHOWTIMES ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể lấy danh sách suất diễn"
        });
    }
});

// ==========================================
// POST /api/admin/tickets/cancel
// body: { password, showId, showtimeId, seatId }
// ==========================================

router.post("/admin/tickets/cancel", requirePin, async (req, res) => {

    try {

        // showId luôn dùng hằng SHOW_ID của server, KHÔNG tin giá trị client
        // gửi (tránh ghép chuỗi lạ vào đường dẫn Firestore).
        const { showtimeId, seatId } = req.body;

        const result = await cancelTicketBySeat({ showId: SHOW_ID, showtimeId, seatId });

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
            showtimeId,
            seatId,
            customerName,
            customerPhone,
            customerEmail
        } = req.body;

        // showId luôn dùng hằng SHOW_ID của server, không tin client gửi.
        const result = await createManualTicket({
            showId: SHOW_ID,
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

// ==========================================
// POST /api/admin/orders/delete
// body: { password, orderId }
// Xoá hẳn đơn (đơn rác/test) + ticket liên quan, trả ghế về AVAILABLE.
// Dùng cho trang partner-orders.html (công cụ Admin, khoá riêng PIN này,
// tách khỏi PARTNER_API_KEY chỉ-đọc).
// ==========================================

router.post("/admin/orders/delete", requirePin, async (req, res) => {

    try {

        const { orderId } = req.body;

        const result = await deleteOrder({ showId: SHOW_ID, orderId });

        return res.status(200).json({
            success: true,
            message: "Đã xoá đơn hàng",
            result
        });

    } catch (error) {

        console.error("ADMIN DELETE ORDER ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể xoá đơn hàng"
        });
    }
});

// ==========================================
// POST /api/admin/orders/update
// body: { password, orderId, customerName?, customerPhone?, customerEmail? }
// ==========================================

router.post("/admin/orders/update", requirePin, async (req, res) => {

    try {

        const { orderId, customerName, customerPhone, customerEmail } = req.body;

        const result = await updateOrderCustomerInfo({
            showId: SHOW_ID,
            orderId,
            customerName,
            customerPhone,
            customerEmail
        });

        return res.status(200).json({
            success: true,
            message: "Đã cập nhật đơn hàng",
            result
        });

    } catch (error) {

        console.error("ADMIN UPDATE ORDER ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể cập nhật đơn hàng"
        });
    }
});

router.post("/admin/orders/lookup", requirePin, async (req, res) => {
    try {
        const order = await findOrderByCode({ showId: SHOW_ID, orderCode: req.body.orderCode });
        return res.status(200).json({ success: true, order });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message || "Không thể tra cứu đơn" });
    }
});

router.post("/admin/orders/resend-ticket-email", requirePin, async (req, res) => {
    try {
        const result = await resendOrderTicketEmail({ showId: SHOW_ID, orderId: req.body.orderId });
        return res.status(200).json({ success: true, ...result });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message || "Không thể gửi lại email vé" });
    }
});

// ==========================================
// POST /api/admin/orders/exchange-tickets
// body: { password, orderId, toShowtimeId, toSeatIds }
// Đổi toàn bộ vé hợp lệ của một đơn đã thanh toán. Transaction sẽ huỷ QR cũ,
// trả ghế cũ, cấp ghế/QR mới; email chỉ được gửi sau khi commit thành công.
// ==========================================

router.post("/admin/orders/exchange-tickets", requirePin, async (req, res) => {

    try {

        const { orderId, toShowtimeId, toSeatIds } = req.body;
        const result = await exchangePaidOrderTickets({
            showId: SHOW_ID,
            orderId,
            toShowtimeId,
            toSeatIds
        });

        try {
            await sendTicketEmail(result.order, result.tickets);
        } catch (emailError) {
            // Đổi vé đã commit thành công; không throw để nhân viên không gọi
            // lại endpoint và vô tình đổi một lần nữa. Có thể gửi lại mail sau.
            console.error("ADMIN EXCHANGE TICKET EMAIL ERROR:", emailError);
            return res.status(200).json({
                success: true,
                emailSent: false,
                message: "Đã đổi vé nhưng gửi email thất bại; cần gửi lại email vé.",
                cancelledTicketCodes: result.cancelledTicketCodes,
                tickets: result.tickets
            });
        }

        return res.status(200).json({
            success: true,
            emailSent: true,
            message: "Đã đổi vé, huỷ QR cũ và gửi email vé mới",
            cancelledTicketCodes: result.cancelledTicketCodes,
            tickets: result.tickets
        });

    } catch (error) {

        console.error("ADMIN EXCHANGE TICKETS ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể đổi vé"
        });
    }
});

module.exports = router;
