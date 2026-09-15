const crypto = require("crypto");
const { db } = require("../config/firebase");

const SHOW_ID = "son-than-thuy-quai";

// Không có giá trị mặc định như ADMIN_PIN — thiếu env thì fail-closed
// (checkPartnerKey luôn trả false), tránh vô tình chạy production với key
// rỗng/đoán được. Đây là key riêng cho đối tác ngoài xem đơn/vé (chỉ đọc),
// tách hẳn khỏi ADMIN_PIN (PIN đó huỷ/tạo được vé thật).
const PARTNER_API_KEY = process.env.PARTNER_API_KEY || "";

// So sánh hằng-thời-gian như checkPin() trong admin.service.js — cùng lý do
// (khác độ dài trả false ngay, không so từng ký tự để tránh rò rỉ qua thời
// gian phản hồi).
function checkPartnerKey(key) {
    if (!PARTNER_API_KEY) return false;
    if (typeof key !== "string") return false;
    const a = Buffer.from(key);
    const b = Buffer.from(PARTNER_API_KEY);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

const ALLOWED_STATUS = new Set(["PAID", "PENDING_PAYMENT", "CANCELLED", "EXPIRED"]);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// ==========================================
// LIỆT KÊ ĐƠN HÀNG CHO ĐỐI TÁC — chỉ đọc, không có endpoint ghi tương ứng.
// Lọc theo showtimeId/status tuỳ chọn, phân trang bằng cursor (createdAt
// của bản ghi cuối cùng ở trang trước, dạng ISO string).
// ==========================================

async function listOrdersForPartner({ showtimeId, status, limit, cursor } = {}) {

    let q = db.collection("orders").where("showId", "==", SHOW_ID);

    if (showtimeId) {
        q = q.where("showtimeId", "==", showtimeId);
    }

    if (status) {
        if (!ALLOWED_STATUS.has(status)) {
            throw new Error(`Trạng thái không hợp lệ: ${status}`);
        }
        q = q.where("orderStatus", "==", status);
    }

    const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    q = q.orderBy("createdAt", "desc").limit(safeLimit);

    if (cursor) {
        const cursorDate = new Date(cursor);
        if (Number.isNaN(cursorDate.getTime())) {
            throw new Error("Cursor không hợp lệ");
        }
        q = q.startAfter(cursorDate);
    }

    const snap = await q.get();

    const orders = snap.docs.map((doc) => {
        const d = doc.data();
        return {
            orderId: doc.id,
            orderCode: d.orderCode,
            showtimeId: d.showtimeId,
            orderStatus: d.orderStatus,
            customerName: d.customerName || "",
            customerPhone: d.customerPhone || "",
            customerEmail: d.customerEmail || "",
            seatIds: d.seatIds || [],
            amount: d.amount || 0,
            source: d.source || "online",
            createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : null,
            paidAt: d.paidAt ? d.paidAt.toDate().toISOString() : null
        };
    });

    const lastDoc = snap.docs[snap.docs.length - 1];
    const nextCursor = (lastDoc && snap.docs.length === safeLimit)
        ? lastDoc.data().createdAt.toDate().toISOString()
        : null;

    return { orders, nextCursor };
}

module.exports = {
    checkPartnerKey,
    listOrdersForPartner
};
