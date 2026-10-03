const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const {
    checkPin,
    checkGateKey,
    lookupTicketByCode,
    checkInTicketByCode,
    checkInOrderByTicketCode,
    logGateScan,
    listGateScanHistory,
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

// Giới hạn — đây là endpoint nhạy cảm nhất hệ thống (huỷ/tạo vé bằng tay),
// PIN chỉ 7 số nên vẫn cần 1 lớp chặn dò mật khẩu. skipSuccessfulRequests:
// chỉ đếm request LỖI (sai PIN = 401, hoặc lỗi nghiệp vụ 400) vào giới hạn
// — request thành công (200/201) không tính.
// limit=300 (từng là 20): nhiều thao tác hàng loạt mới thêm (admin-news.html
// kéo-thả, admin-showtimes.html sửa hàng loạt/mode "Đã bán"/Hoàn tác) gọi
// API RIÊNG LẺ cho từng ghế/mục trong 1 lượt — nếu vài mục trong lô lỗi
// (VD vài ghế không còn trống) thì mỗi lỗi đó vẫn tính vào giới hạn dù PIN
// luôn đúng, dễ dính "Quá nhiều yêu cầu" khi thao tác lô lớn dù không hề dò
// mật khẩu. 300 lần/15 phút vẫn vô nghĩa với ai thật sự dò PIN 7 số (10
// triệu tổ hợp) nên không giảm khả năng chặn brute-force thật sự.
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 phút
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    // /admin/tickets/checkin và /admin/tickets/lookup có giới hạn RIÊNG
    // (gateLimiter bên dưới) — tần suất quét vé ở cổng cao hơn hẳn thao tác
    // admin thường, không nên dùng chung ngưỡng 300/15 phút.
    skip: (req) => req.path === "/admin/tickets/checkin" || req.path === "/admin/tickets/lookup",
    message: {
        success: false,
        message: "Quá nhiều yêu cầu, vui lòng thử lại sau."
    }
});

router.use("/admin", adminLimiter);

// Riêng cho check-in tại cổng: quét liên tục suốt giờ mở cửa, lưu lượng
// thật cao hơn nhiều so với thao tác admin tay. skipSuccessfulRequests vẫn
// bật — vé đã check-in/huỷ/xung đột trả về HTTP 200 (chỉ khác success:false
// trong body), không phải lỗi credential nên không nên tính vào giới hạn;
// chỉ sai gateKey (401) mới tính, vẫn đủ chặn dò khoá.
const gateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 3000,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
        success: false,
        message: "Quá nhiều yêu cầu, vui lòng thử lại sau."
    }
});

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

// Khóa riêng cho app soát vé — xem checkGateKey() trong admin.service.js.
function requireGateKey(req, res, next) {
    if (!checkGateKey(req.body.gateKey)) {
        return res.status(401).json({
            success: false,
            message: "Sai khoá app soát vé"
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
// POST /api/admin/tickets/lookup
// body: { gateKey, ticketCode }
// Tra cứu READ-ONLY (không check-in) — màn hình "hiện thông tin vé" ngay sau
// khi quét, trước khi nhân viên đối chiếu khách rồi tự bấm nút CHECK-IN (gọi
// /admin/tickets/checkin riêng, bên dưới). Dùng chung logic phân loại với
// checkin qua classifyTicketForGate() trong admin.service.js.
// ==========================================

router.post("/admin/tickets/lookup", gateLimiter, requireGateKey, async (req, res) => {

    try {

        const { ticketCode } = req.body;

        const result = await lookupTicketByCode({ ticketCode });

        // Chỉ log khi KHÔNG ready — vé ready sẽ có /checkin hoặc /checkin-order
        // gọi ngay sau đó, log ở đó mới là kết quả CUỐI của lượt quét (tránh ghi
        // trùng 2 dòng lịch sử cho đúng 1 lượt quét). Bỏ qua mã dò khoá gate
        // ("GATE-KEY-VERIFY", dùng khi mở trang) để không rác lịch sử thật.
        if (!result.ready && ticketCode !== "GATE-KEY-VERIFY") {
            logGateScan({
                ticketCode: result.ticketCode,
                customerName: result.customerName,
                seats: result.seatId ? [result.seatId] : [],
                showtimeId: result.showtimeId,
                outcome: result.outcome,
                checkedInCount: 0,
                totalCount: 1,
                message: result.message,
                testMode: false
            }).catch((err) => console.error("LOG GATE SCAN ERROR:", err));
        }

        return res.status(200).json({
            success: true,
            ready: result.ready,
            message: result.message,
            ticket: {
                ticketCode: result.ticketCode,
                seatId: result.seatId,
                customerName: result.customerName,
                showtimeId: result.showtimeId,
                tierName: result.tierName,
                price: result.price
            }
        });

    } catch (error) {

        console.error("GATE LOOKUP ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể tra cứu vé"
        });
    }
});

// ==========================================
// POST /api/admin/tickets/checkin
// body: { gateKey, ticketCode, dryRun? }
// dryRun=true (gate-scanner.html tick "TestScan"): vẫn chấm outcome y hệt
// thật, chỉ bỏ qua bước ghi checkedIn — tester quét lại cùng 1 mã nhiều
// lần không cần tạo mã mới (xem checkInTicketDoc() trong admin.service.js).
// Dùng bởi app soát vé Unity thay cho đọc/ghi Firestore trực tiếp (xem
// checkInTicketByCode() trong admin.service.js cho toàn bộ logic transaction
// + lý do — đây là phần vá cho C1/C7 trong CLAUDE.md). Luôn trả HTTP 200 cho
// mọi kết quả nghiệp vụ hợp lệ (đã check-in/huỷ/xung đột/sai ngày...), chỉ
// 401 khi sai gateKey và 400 khi thiếu ticketCode — để gateLimiter không
// tính nhầm việc quét trùng/quét rác vào giới hạn request.
// ==========================================

router.post("/admin/tickets/checkin", gateLimiter, requireGateKey, async (req, res) => {

    try {

        const { ticketCode, dryRun } = req.body;

        const result = await checkInTicketByCode({ ticketCode, dryRun: !!dryRun });

        logGateScan({
            ticketCode: result.ticketCode,
            customerName: result.customerName,
            seats: result.seatId ? [result.seatId] : [],
            showtimeId: result.showtimeId,
            outcome: result.outcome,
            checkedInCount: result.success ? 1 : 0,
            totalCount: 1,
            message: result.message,
            testMode: !!dryRun
        }).catch((err) => console.error("LOG GATE SCAN ERROR:", err));

        return res.status(200).json({
            success: result.success,
            alreadyCheckedIn: result.alreadyCheckedIn,
            message: result.message,
            ticket: {
                ticketCode: result.ticketCode,
                seatId: result.seatId,
                customerName: result.customerName,
                showtimeId: result.showtimeId
            }
        });

    } catch (error) {

        console.error("GATE CHECKIN ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể check-in vé"
        });
    }
});

// ==========================================
// POST /api/admin/tickets/checkin-order
// body: { gateKey, ticketCode, dryRun? } — xem ghi chú dryRun ở /checkin phía trên.
// Quét ĐÚNG 1 mã vé bất kỳ trong đơn, check-in TOÀN BỘ vé cùng orderId —
// cho trường hợp khách mua nhiều ghế trong 1 đơn, dùng khi gate-scanner.html
// tick "check-in cả đơn" (xem checkInOrderByTicketCode() trong admin.service.js).
// Cùng gateLimiter/requireGateKey với /checkin, luôn trả HTTP 200 cho kết
// quả nghiệp vụ hợp lệ.
// ==========================================

router.post("/admin/tickets/checkin-order", gateLimiter, requireGateKey, async (req, res) => {

    try {

        const { ticketCode, dryRun } = req.body;

        const result = await checkInOrderByTicketCode({ ticketCode, dryRun: !!dryRun });

        logGateScan({
            ticketCode,
            customerName: result.customerName,
            seats: (result.tickets || []).filter((t) => t.success).map((t) => t.seatId).filter(Boolean),
            showtimeId: result.showtimeId,
            outcome: result.outcome,
            checkedInCount: result.checkedInCount,
            totalCount: result.totalInOrder,
            message: result.checkedInCount === result.totalInOrder ? "Đã check-in cả đơn" : "Check-in cả đơn (một phần)",
            testMode: !!dryRun
        }).catch((err) => console.error("LOG GATE SCAN ERROR:", err));

        return res.status(200).json({
            success: result.outcome !== "NOT_FOUND",
            outcome: result.outcome,
            orderId: result.orderId,
            customerName: result.customerName,
            showtimeId: result.showtimeId,
            totalInOrder: result.totalInOrder,
            checkedInCount: result.checkedInCount,
            tickets: result.tickets
        });

    } catch (error) {

        console.error("GATE CHECKIN ORDER ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể check-in đơn"
        });
    }
});

// ==========================================
// POST /api/admin/tickets/scan-history
// body: { gateKey }
// Trả tối đa 100 lượt quét gần nhất (xem logGateScan()/listGateScanHistory()
// trong admin.service.js) cho trang frontend/gate-scan-history.html. Khoá
// bằng gateKey (không phải PIN) vì đây vẫn là màn hình của nhân viên soát
// vé, không phải admin tool. Tần suất xem thấp nên không cần gateLimiter
// riêng — dùng chung adminLimiter mặc định của router (route này không nằm
// trong danh sách skip phía trên).
// ==========================================

router.post("/admin/tickets/scan-history", requireGateKey, async (req, res) => {

    try {

        const history = await listGateScanHistory();

        return res.status(200).json({ success: true, history });

    } catch (error) {

        console.error("GATE SCAN HISTORY ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể tải lịch sử quét vé"
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
