const express = require("express");
const router = express.Router();

const { listNews } = require("../services/news.service");

// ==========================================
// GET /api/news
// Công khai, không cần PIN — mục "TIN TỨC" trên trang chủ (index.html) gọi
// thẳng endpoint này thay vì đọc mảng hardcode như trước.
// ==========================================

router.get("/news", async (req, res) => {

    try {

        const news = await listNews();

        return res.status(200).json({
            success: true,
            news
        });

    } catch (error) {

        console.error("GET NEWS ERROR:", error);

        return res.status(500).json({
            success: false,
            message: error.message || "Không thể lấy tin tức"
        });
    }
});

module.exports = router;
