const { db } = require("../config/firebase");
const { FieldValue } = require("firebase-admin/firestore");

// ==========================================
// TIN TỨC (mục "NHỮNG GÌ ĐANG DIỄN RA" trên trang chủ) — trước đây là mảng
// NEWS_ITEMS hardcode thẳng trong frontend/index.html, sửa xong phải tự deploy
// lại mới lên được. Giờ chuyển vào Firestore (collection "news", đọc công khai
// qua GET /api/news) để trang quản trị admin-news.html tạo/xoá được ngay,
// không cần đụng code/deploy lại mỗi lần thêm 1 bài báo.
// Mỗi ảnh minh hoạ (img) vẫn phải tự tay đặt sẵn file vào
// frontend/image/News/ rồi mới nhập đúng tên file vào đây — trang admin
// không có chức năng tải ảnh lên.
// ==========================================

function serializeNews(doc) {
    const data = doc.data();
    return {
        id: doc.id,
        img: data.img || null,
        youtubeId: data.youtubeId || null,
        imgPosition: data.imgPosition || null,
        href: data.href,
        org: data.org,
        title: data.title,
        desc: data.desc,
        publishedAt: data.publishedAt ? data.publishedAt.toDate().toISOString() : null
    };
}

async function listNews() {
    const snap = await db.collection("news").orderBy("publishedAt", "desc").get();
    return snap.docs.map(serializeNews);
}

async function createNews({ img, youtubeId, imgPosition, href, org, title, desc, publishedAt }) {

    if (!href || !String(href).trim()) {
        throw new Error("Thiếu link bài viết (href)");
    }

    if (!org || !String(org).trim()) {
        throw new Error("Thiếu tên tổ chức/nguồn tin (org)");
    }

    if (!img && !youtubeId) {
        throw new Error("Cần ảnh minh hoạ (img) hoặc mã video YouTube (youtubeId)");
    }

    if (!title || !String(title.vi || "").trim()) {
        throw new Error("Thiếu tiêu đề tiếng Việt");
    }

    if (!desc || !String(desc.vi || "").trim()) {
        throw new Error("Thiếu nội dung tiếng Việt");
    }

    const publishedDate = publishedAt ? new Date(publishedAt) : new Date();
    if (isNaN(publishedDate.getTime())) {
        throw new Error("Ngày đăng (publishedAt) không hợp lệ");
    }

    const docRef = await db.collection("news").add({
        img: img || null,
        youtubeId: youtubeId || null,
        imgPosition: imgPosition || null,
        href: String(href).trim(),
        org: String(org).trim(),
        // Chưa có bản dịch tiếng Anh thì tạm dùng lại tiếng Việt — tin tức báo
        // chí bên ngoài thường giữ nguyên ngôn ngữ gốc cũng là chuyện bình
        // thường, không bắt buộc phải dịch ngay mới hiển thị được.
        title: { vi: String(title.vi).trim(), en: String(title.en || title.vi).trim() },
        desc: { vi: String(desc.vi).trim(), en: String(desc.en || desc.vi).trim() },
        publishedAt: publishedDate,
        createdAt: FieldValue.serverTimestamp()
    });

    return { newsId: docRef.id };
}

async function deleteNews({ newsId }) {

    if (!newsId) {
        throw new Error("Thiếu newsId");
    }

    const ref = db.collection("news").doc(newsId);
    const snap = await ref.get();

    if (!snap.exists) {
        throw new Error("Không tìm thấy tin tức này");
    }

    await ref.delete();

    return { newsId };
}

module.exports = {
    listNews,
    createNews,
    deleteNews
};
