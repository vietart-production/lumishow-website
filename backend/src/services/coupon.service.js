const { db } = require("../config/firebase");

// ==========================================
// MÃ GIẢM GIÁ (COUPON) — % GIẢM TRÊN TỔNG GIÁ GHẾ
// ------------------------------------------
// Firestore: coupons/{CODE} — CODE là chính doc ID (viết hoa), field:
//   percentOff  number, 1-100
//   active      boolean — tắt mã mà không cần xoá
//   expiresAt   Timestamp | null — không có thì không giới hạn hạn dùng
//   maxUses     number | null — không có thì không giới hạn lượt dùng
//   usedCount   number — chỉ tăng khi đơn đã PAID thật (xem payment.service.js)
//
// Quan trọng: percentOff hiển thị ở bước "Áp dụng" chỉ để khách xem trước.
// Số tiền THẬT luôn được tính lại từ đầu (đọc lại coupons/{CODE} + giá ghế
// thật) ngay tại thời điểm tạo payment link — không bao giờ tin percentOff
// hay số tiền do client gửi lên.
// ==========================================

function normalizeCode(rawCode) {
    return String(rawCode || "").trim().toUpperCase();
}

// Đọc + kiểm tra hiệu lực coupon tại thời điểm gọi. Chỉ đọc, không ghi gì.
async function getCouponStatus(rawCode) {

    const code = normalizeCode(rawCode);

    if (!code) {
        return { valid: false, message: "Vui lòng nhập mã giảm giá." };
    }

    const snap = await db.collection("coupons").doc(code).get();

    if (!snap.exists) {
        return { valid: false, message: "Mã giảm giá không tồn tại." };
    }

    const data = snap.data();

    if (data.active !== true) {
        return { valid: false, message: "Mã giảm giá đã ngừng áp dụng." };
    }

    const percentOff = Number(data.percentOff);

    if (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 100) {
        return { valid: false, message: "Mã giảm giá không hợp lệ." };
    }

    const expiresAt = data.expiresAt?.toDate
        ? data.expiresAt.toDate()
        : (data.expiresAt ? new Date(data.expiresAt) : null);

    if (expiresAt && expiresAt <= new Date()) {
        return { valid: false, message: "Mã giảm giá đã hết hạn." };
    }

    const maxUses = data.maxUses != null ? Number(data.maxUses) : null;
    const usedCount = Number(data.usedCount || 0);

    if (maxUses != null && Number.isFinite(maxUses) && usedCount >= maxUses) {
        return { valid: false, message: "Mã giảm giá đã hết lượt sử dụng." };
    }

    return { valid: true, code, percentOff };
}

// Số tiền thanh toán tối thiểu PayOS chấp nhận — chặn coupon giảm quá sâu
// khiến payment link 0đ hoặc gần 0đ (không hợp lệ / vô nghĩa).
const MIN_PAYABLE_AMOUNT = 1000;

// Dùng NGAY TRƯỚC khi tạo payment link thật — validate lại từ đầu (không
// tin trạng thái đã kiểm tra trước đó ở bước "Áp dụng", vì có thể coupon
// đã bị tắt/hết hạn/hết lượt trong lúc khách đang điền form) rồi tính tiền
// từ subtotal (đã tính từ giá ghế thật trong Firestore, do payment.service
// truyền vào — không phải số client gửi).
async function applyCouponToAmount(rawCode, subtotal) {

    const status = await getCouponStatus(rawCode);

    if (!status.valid) {
        const error = new Error(status.message || "Mã giảm giá không hợp lệ.");
        error.code = "INVALID_COUPON";
        throw error;
    }

    const discount = Math.round(subtotal * status.percentOff / 100);
    const amount = subtotal - discount;

    // amount = 0 hợp lệ (coupon 100%) — đơn miễn phí hoàn toàn, không qua
    // PayOS (xem payment.service.js). Chỉ chặn khoảng giữa 1-999đ: số tiền
    // dương nhưng quá nhỏ để tạo payment link PayOS có nghĩa.
    if (amount > 0 && amount < MIN_PAYABLE_AMOUNT) {
        const error = new Error(
            "Mã giảm giá khiến số tiền thanh toán quá thấp, không thể áp dụng."
        );
        error.code = "COUPON_AMOUNT_TOO_LOW";
        throw error;
    }

    return {
        code: status.code,
        percentOff: status.percentOff,
        subtotal,
        discount,
        amount
    };
}

module.exports = {
    normalizeCode,
    getCouponStatus,
    applyCouponToAmount
};
