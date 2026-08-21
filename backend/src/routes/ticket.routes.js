const express = require("express");
const QRCode = require("qrcode");

const router = express.Router();

// ==========================================
// GET /api/tickets/:ticketCode/qr.png
// ------------------------------------------
// Sinh ảnh QR PNG thật (không phải base64 nhúng trong HTML) để dùng trong
// mail vé — nhiều mail client (Gmail, Outlook...) tự strip ảnh dạng
// data:base64 nhúng trong HTML gửi qua API vì lý do chống spam/bảo mật,
// khiến ảnh QR không hiện được (src rỗng). Route này chỉ vẽ QR từ đúng
// chuỗi ticketCode truyền vào, không tra cứu Firestore, không lộ dữ liệu.
// ==========================================

router.get("/tickets/:ticketCode/qr.png", async (req, res) => {

    try {

        const { ticketCode } = req.params;

        const buffer = await QRCode.toBuffer(ticketCode, {
            margin: 1,
            width: 400
        });

        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        // Helmet mặc định set same-origin, sẽ chặn ảnh load trong mail client
        // (Gmail webmail render mail ở origin khác) — nới riêng route ảnh công khai này.
        res.set("Cross-Origin-Resource-Policy", "cross-origin");

        return res.send(buffer);

    } catch (error) {

        console.error("GENERATE QR ERROR:", error);

        return res.status(400).json({
            success: false,
            message: "Không thể tạo mã QR"
        });

    }

});

module.exports = router;
