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
    exchangePaidOrderTickets,
    getShowtimesCalendar,
    createShowtime,
    setShowtimesStatus,
    deleteShowtime,
    bulkUpdateSeats,
    renameSeat
} = require("../services/admin.service");
const { sendTicketEmail } = require("../services/email.service");
const { createNews, updateNews, reorderNews, deleteNews } = require("../services/news.service");
const { logAdminActivity, listAdminActivity } = require("../services/activityLog.service");

const SHOW_ID = "son-than-thuy-quai";

// Giới hạn chặt — đây là endpoint nhạy cảm nhất hệ thống (huỷ/tạo vé bằng
// tay), PIN chỉ 7 số nên cần chặn dò mật khẩu tích cực hơn rate-limit chung.
// skipSuccessfulRequests: chỉ đếm request LỖI (sai PIN = 401, hoặc lỗi
// nghiệp vụ 400) vào giới hạn — request thành công (200/201) không tính.
// Các trang nội bộ (admin-news.html kéo-thả, admin-showtimes.html sửa hàng
// loạt...) gọi API liên tục với PIN ĐÚNG trong 1 phiên làm việc, tự dưng
// dính "Quá nhiều yêu cầu" dù không hề dò mật khẩu — giữ nguyên chặn brute-
// force (vẫn đếm 401 sai PIN) mà không làm phiền người dùng nội bộ hợp lệ.
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 phút
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
        success: false,
        message: "Quá nhiều yêu cầu, vui lòng thử lại sau."
    }
});

router.use("/admin", adminLimiter);

// Ghi lịch sử thao tác admin — bọc res.json() 1 lần cho TOÀN BỘ /admin/*
// thay vì từng hàm trong admin.service.js tự gọi, để endpoint thêm sau này
// tự động được ghi log mà không ai phải nhớ thêm gì (xem giải thích đầy đủ ở
// đầu activityLog.service.js). Trả response cho client TRƯỚC (originalJson),
// rồi mới ghi log không đợi (không được để lỗi ghi log làm hỏng response
// thật hoặc làm chậm request).
router.use("/admin", (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        const result = originalJson(body);
        logAdminActivity({
            path: req.path,
            method: req.method,
            statusCode: res.statusCode,
            body: req.body,
            responseMessage: body && body.message
        }).catch((err) => console.error("LOG ADMIN ACTIVITY ERROR:", err));
        return result;
    };
    next();
});

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

// ==========================================
// TRANG "QUẢN LÝ SUẤT DIỄN" (admin-showtimes.html) — xem admin.service.js
// cho chi tiết guard/logic từng hàm.
// ==========================================

router.post("/admin/showtimes/calendar", requirePin, async (req, res) => {
    try {
        const { year, month } = req.body;
        const showtimes = await getShowtimesCalendar({ showId: SHOW_ID, year, month });
        return res.status(200).json({ success: true, showtimes });
    } catch (error) {
        console.error("ADMIN CALENDAR ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể tải lịch suất diễn" });
    }
});

router.post("/admin/showtimes/create", requirePin, async (req, res) => {
    try {
        const { showtimeId } = req.body;
        const result = await createShowtime({ showId: SHOW_ID, showtimeId });
        return res.status(201).json({ success: true, message: "Đã tạo suất diễn mới (trạng thái CLOSED)", ...result });
    } catch (error) {
        console.error("ADMIN CREATE SHOWTIME ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể tạo suất diễn" });
    }
});

router.post("/admin/showtimes/set-status", requirePin, async (req, res) => {
    try {
        const { showtimeIds, status } = req.body;
        const result = await setShowtimesStatus({ showId: SHOW_ID, showtimeIds, status });
        return res.status(200).json({ success: true, message: "Đã cập nhật trạng thái suất diễn", ...result });
    } catch (error) {
        console.error("ADMIN SET STATUS ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể cập nhật trạng thái" });
    }
});

router.post("/admin/showtimes/delete", requirePin, async (req, res) => {
    try {
        const { showtimeId } = req.body;
        const result = await deleteShowtime({ showId: SHOW_ID, showtimeId });
        return res.status(200).json({ success: true, message: "Đã xoá suất diễn", ...result });
    } catch (error) {
        console.error("ADMIN DELETE SHOWTIME ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể xoá suất diễn" });
    }
});

router.post("/admin/seats/bulk-update", requirePin, async (req, res) => {
    try {
        const { showtimeId, seatIds, status, blockNote } = req.body;
        const result = await bulkUpdateSeats({ showId: SHOW_ID, showtimeId, seatIds, status, blockNote });
        return res.status(200).json({ success: true, message: "Đã cập nhật trạng thái ghế", ...result });
    } catch (error) {
        console.error("ADMIN BULK UPDATE SEATS ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể cập nhật ghế" });
    }
});

router.post("/admin/seats/rename", requirePin, async (req, res) => {
    try {
        const { showtimeId, oldSeatId, newSeatId } = req.body;
        const result = await renameSeat({ showId: SHOW_ID, showtimeId, oldSeatId, newSeatId });
        return res.status(200).json({ success: true, message: "Đã đổi mã ghế", ...result });
    } catch (error) {
        console.error("ADMIN RENAME SEAT ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể đổi mã ghế" });
    }
});

// ==========================================
// TRANG "QUẢN LÝ TIN TỨC" (admin-news.html) — tạo/xoá tin trong collection
// "news" (đọc công khai qua GET /api/news, xem news.service.js).
// ==========================================

router.post("/admin/news/create", requirePin, async (req, res) => {
    try {
        const { img, youtubeId, imgPosition, href, org, title, desc, publishedAt } = req.body;
        const result = await createNews({ img, youtubeId, imgPosition, href, org, title, desc, publishedAt });
        return res.status(201).json({ success: true, message: "Đã tạo tin tức mới", ...result });
    } catch (error) {
        console.error("ADMIN CREATE NEWS ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể tạo tin tức" });
    }
});

router.post("/admin/news/update", requirePin, async (req, res) => {
    try {
        const { newsId, img, youtubeId, href, org, title, desc, publishedAt } = req.body;
        const result = await updateNews({ newsId, img, youtubeId, href, org, title, desc, publishedAt });
        return res.status(200).json({ success: true, message: "Đã cập nhật tin tức", ...result });
    } catch (error) {
        console.error("ADMIN UPDATE NEWS ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể cập nhật tin tức" });
    }
});

router.post("/admin/news/reorder", requirePin, async (req, res) => {
    try {
        const { ids } = req.body;
        const result = await reorderNews({ ids });
        return res.status(200).json({ success: true, message: "Đã cập nhật thứ tự", ...result });
    } catch (error) {
        console.error("ADMIN REORDER NEWS ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể cập nhật thứ tự" });
    }
});

router.post("/admin/news/delete", requirePin, async (req, res) => {
    try {
        const { newsId } = req.body;
        const result = await deleteNews({ newsId });
        return res.status(200).json({ success: true, message: "Đã xoá tin tức", ...result });
    } catch (error) {
        console.error("ADMIN DELETE NEWS ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể xoá tin tức" });
    }
});

// ==========================================
// POST /api/admin/activity/list
// body: { password, category?, dateFrom?, dateTo?, limit?, cursor? }
// Chỉ đọc — trang admin-activity-log.html. Bản thân endpoint này KHÔNG bị
// ghi vào chính lịch sử (nằm trong SKIP_LOG_PATHS ở activityLog.service.js).
// ==========================================

router.post("/admin/activity/list", requirePin, async (req, res) => {
    try {
        const { category, dateFrom, dateTo, limit, cursor } = req.body;
        const result = await listAdminActivity({ category, dateFrom, dateTo, limit, cursor });
        return res.status(200).json({ success: true, ...result });
    } catch (error) {
        console.error("ADMIN LIST ACTIVITY ERROR:", error);
        return res.status(400).json({ success: false, message: error.message || "Không thể lấy lịch sử thao tác" });
    }
});

module.exports = router;
