const { db } = require("../config/firebase");
const { FieldValue } = require("firebase-admin/firestore");

// ==========================================
// LỊCH SỬ THAO TÁC ADMIN (audit log) — ghi lại MỌI request /api/admin/*
// mutating thành công, để trang admin-activity-log.html hiển thị lại.
// Middleware gọi logAdminActivity() ở admin.routes.js, KHÔNG phải từng hàm
// trong admin.service.js tự gọi — endpoint admin thêm sau này tự động được
// ghi log mà không ai phải nhớ thêm dòng nào (đây chính là điều đã thiếu
// suốt lịch sử dự án: nhiều thao tác qua script tmp_*.js không để lại dấu
// vết gì). CHỈ ghi log từ lúc tính năng này triển khai trở đi — không cố
// tái tạo lịch sử cũ (không đủ dữ liệu để tái tạo đáng tin cậy).
// ==========================================

// Suy category từ đoạn path đầu tiên sau /admin/ — tự động, nhất quán, khỏi
// phải gắn tay từng endpoint. CATEGORY_OVERRIDE xử lý đúng 1 trường hợp path
// lệch ngữ nghĩa (exchange-tickets nằm dưới orders/ nhưng bản chất là thao
// tác vé) — thêm entry mới vào đây nếu sau này phát sinh case tương tự,
// không cần đổi cơ chế suy category theo path.
const CATEGORY_BY_PREFIX = {
    tickets: "Vé",
    orders: "Đơn hàng",
    showtimes: "Suất diễn",
    seats: "Ghế",
    news: "Tin tức"
};
const CATEGORY_OVERRIDE = {
    "/admin/orders/exchange-tickets": "Vé"
};

// Endpoint chỉ-đọc (không mutating gì) — không log, tránh nhiễu lịch sử với
// những request không thật sự thay đổi dữ liệu.
const SKIP_LOG_PATHS = new Set([
    "/admin/verify-pin",
    "/admin/showtimes/list",
    "/admin/orders/lookup",
    "/admin/showtimes/calendar",
    "/admin/activity/list",
    // Tần suất quét vé ở cổng (gate check-in/lookup) cao hơn hẳn thao tác
    // admin tay — không log để tránh ngập adminActivityLog, chỉ ghi chú
    // cancel/create vé tay (đã log sẵn qua 2 route riêng) mới là thao tác
    // cần soát lại.
    "/admin/tickets/checkin",
    "/admin/tickets/checkin-order",
    "/admin/tickets/lookup"
]);

function deriveCategory(path) {
    if (CATEGORY_OVERRIDE[path]) return CATEGORY_OVERRIDE[path];
    const prefix = path.replace(/^\/admin\//, "").split("/")[0];
    return CATEGORY_BY_PREFIX[prefix] || "Khác";
}

// Câu tóm tắt dễ đọc cho từng path đã biết — path lạ (endpoint thêm sau này
// mà quên cập nhật summarize) tự rơi về hiển thị JSON thô của body, không
// vỡ/thiếu log, chỉ kém đẹp hơn.
function summarize(path, body) {
    switch (path) {
        case "/admin/tickets/cancel":
            return `Huỷ vé ghế ${body.seatId}, suất ${body.showtimeId}`;
        case "/admin/tickets/create":
            return `Tạo vé thủ công: ${(body.seatIds || []).join(", ")}, suất ${body.showtimeId}, khách "${body.customerName || ""}"`;
        case "/admin/orders/delete":
            return `Xoá đơn ${body.orderId}`;
        case "/admin/orders/update":
            return `Sửa thông tin khách đơn ${body.orderId}`;
        case "/admin/orders/resend-ticket-email":
            return `Gửi lại email vé cho đơn ${body.orderId}`;
        case "/admin/orders/exchange-tickets":
            return `Đổi vé đơn ${body.orderId} sang ${(body.toSeatIds || []).join(", ")} (suất ${body.toShowtimeId})`;
        case "/admin/showtimes/create":
            return `Tạo suất diễn ${body.showtimeId}`;
        case "/admin/showtimes/set-status":
            return `Đổi trạng thái suất ${body.showtimeId} -> ${body.status}`;
        case "/admin/showtimes/delete":
            return `Xoá suất diễn ${body.showtimeId}`;
        case "/admin/seats/bulk-update":
            return `Khoá/mở ${(body.seatIds || []).length} ghế (${body.status}) suất ${body.showtimeId}`;
        case "/admin/seats/rename":
            return `Đổi mã ghế ${body.oldSeatId} -> ${body.newSeatId}, suất ${body.showtimeId}`;
        case "/admin/news/create":
            return `Tạo tin: "${body.title?.vi || ""}"`;
        case "/admin/news/update":
            return `Sửa tin ${body.newsId}`;
        case "/admin/news/reorder":
            return `Đổi thứ tự ${(body.ids || []).length} tin`;
        case "/admin/news/delete":
            return `Xoá tin ${body.newsId}`;
        default:
            return path;
    }
}

// Không bao giờ lưu password/PIN vào log dù chỉ dạng đã "xác thực đúng" —
// đây là dữ liệu nhạy cảm, log chỉ cần biết THAO TÁC gì, không cần biết PIN.
function sanitizeBody(body) {
    const { password, apiKey, ...rest } = body || {};
    return rest;
}

async function logAdminActivity({ path, method, statusCode, body, responseMessage }) {
    if (SKIP_LOG_PATHS.has(path)) return;
    if (statusCode >= 300) return; // chỉ log thao tác THẬT SỰ thành công

    const cleanBody = sanitizeBody(body);

    await db.collection("adminActivityLog").add({
        action: path,
        category: deriveCategory(path),
        method,
        statusCode,
        summary: summarize(path, cleanBody),
        requestBody: cleanBody,
        responseMessage: responseMessage || null,
        createdAt: FieldValue.serverTimestamp()
    });
}

const ALLOWED_CATEGORIES = new Set(["Vé", "Đơn hàng", "Suất diễn", "Ghế", "Tin tức", "Khác"]);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

async function listAdminActivity({ category, dateFrom, dateTo, limit, cursor } = {}) {

    let q = db.collection("adminActivityLog");

    if (category) {
        if (!ALLOWED_CATEGORIES.has(category)) {
            throw new Error(`Danh mục không hợp lệ: ${category}`);
        }
        q = q.where("category", "==", category);
    }

    if (dateFrom) {
        const d = new Date(dateFrom);
        if (Number.isNaN(d.getTime())) throw new Error("dateFrom không hợp lệ");
        q = q.where("createdAt", ">=", d);
    }
    if (dateTo) {
        const d = new Date(dateTo);
        if (Number.isNaN(d.getTime())) throw new Error("dateTo không hợp lệ");
        q = q.where("createdAt", "<", d);
    }

    const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    q = q.orderBy("createdAt", "desc").limit(safeLimit);

    if (cursor) {
        const cursorDate = new Date(cursor);
        if (Number.isNaN(cursorDate.getTime())) throw new Error("Cursor không hợp lệ");
        q = q.startAfter(cursorDate);
    }

    const snap = await q.get();

    const entries = snap.docs.map((doc) => {
        const d = doc.data();
        return {
            id: doc.id,
            action: d.action,
            category: d.category,
            summary: d.summary,
            statusCode: d.statusCode,
            requestBody: d.requestBody || {},
            createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : null
        };
    });

    const lastDoc = snap.docs[snap.docs.length - 1];
    const nextCursor = (lastDoc && snap.docs.length === safeLimit)
        ? lastDoc.data().createdAt.toDate().toISOString()
        : null;

    return { entries, nextCursor };
}

module.exports = {
    logAdminActivity,
    listAdminActivity
};
