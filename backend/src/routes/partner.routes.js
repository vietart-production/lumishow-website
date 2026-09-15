const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const { checkPartnerKey, listOrdersForPartner } = require("../services/partner.service");

// Endpoint nhạy cảm (đọc PII khách: tên/SĐT/email) nhưng chỉ đọc, không
// huỷ/tạo được gì — giới hạn nhẹ hơn adminLimiter (huỷ/tạo vé) một chút,
// vẫn đủ chặn dò key.
const partnerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Quá nhiều yêu cầu, vui lòng thử lại sau."
    }
});

router.use("/partner", partnerLimiter);

function requirePartnerKey(req, res, next) {
    if (!checkPartnerKey(req.body.apiKey)) {
        return res.status(401).json({
            success: false,
            message: "Sai hoặc thiếu apiKey"
        });
    }
    next();
}

// ==========================================
// POST /api/partner/orders/list
// body: { apiKey, showtimeId?, status?, limit?, cursor?, sortDir? ("asc"|"desc", mặc định "desc") }
// Chỉ đọc — dùng cho đối tác nghiệp vụ (kế toán/venue) đối soát đơn/vé
// thật, tách hẳn khỏi ADMIN_PIN (huỷ/tạo vé tại cổng).
// ==========================================

router.post("/partner/orders/list", requirePartnerKey, async (req, res) => {

    try {

        const { showtimeId, status, limit, cursor, sortDir } = req.body;

        const result = await listOrdersForPartner({ showtimeId, status, limit, cursor, sortDir });

        return res.status(200).json({
            success: true,
            ...result
        });

    } catch (error) {

        console.error("PARTNER LIST ORDERS ERROR:", error);

        return res.status(400).json({
            success: false,
            message: error.message || "Không thể lấy danh sách đơn hàng"
        });
    }
});

module.exports = router;
