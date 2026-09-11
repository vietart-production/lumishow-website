const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const bookingRoutes = require("./routes/booking.routes");
const paymentRoutes = require("./routes/payment.routes");
const ticketRoutes = require("./routes/ticket.routes");
const contactRoutes = require("./routes/contact.routes");
const adminRoutes = require("./routes/admin.routes");
const couponRoutes = require("./routes/coupon.routes");

const app = express();

// Render (và hầu hết PaaS) đặt app sau 1 reverse proxy — cần khai báo để
// express-rate-limit đọc đúng IP thật từ X-Forwarded-For thay vì báo lỗi
// validation liên tục. Chỉ tin proxy đầu tiên (Render), không tin toàn chuỗi.
app.set("trust proxy", 1);

app.use(helmet());

// Giới hạn số request /api mỗi IP để chống spam gọi /seats hoặc /bookings/hold.
// Bỏ qua webhook PayOS: PayOS gọi từ IP của họ, burst nhiều giao dịch một lúc
// không được để dính 429 (mất xác nhận thanh toán của khách).
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.originalUrl.startsWith("/api/payments/webhook"),
    message: {
        success: false,
        message: "Quá nhiều yêu cầu, vui lòng thử lại sau."
    }
});

// localhost chỉ mở khi chạy dev — production (lumishow.vn) không cần, tránh
// để trang bất kỳ chạy local gọi API thay mặt người dùng.
const allowedOrigins = [
    "https://lumishow.vn",
    "https://www.lumishow.vn",
    "https://sonthanthuyquai-ticket.web.app"
];

if (process.env.NODE_ENV !== "production") {
    allowedOrigins.push("http://127.0.0.1:5500", "http://localhost:5500");
}

app.use(cors({
    origin: function (origin, callback) {

        // Cho phép các request không có Origin trong môi trường local,
        // ví dụ mở trực tiếp health endpoint trên browser/Postman.
        if (!origin) {
            return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        const corsError = new Error("Origin không được phép truy cập API");
        corsError.status = 403;
        return callback(corsError, false);
    },

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],

    allowedHeaders: [
        "Content-Type",
        "Authorization"
    ]
}));
const PORT = process.env.PORT || 3000;


app.use(express.json());

// apiLimiter gắn MỘT lần cho toàn bộ /api — trước đây lặp trên 6 mount khiến
// mỗi request bị đếm 2-6 lần, khách thật dễ dính 429 giữa lúc thanh toán.
app.use("/api", apiLimiter);

app.use("/api", bookingRoutes);
app.use("/api", paymentRoutes);
app.use("/api", ticketRoutes);
app.use("/api", contactRoutes);
app.use("/api", adminRoutes);
app.use("/api", couponRoutes);


// /health trả tĩnh, KHÔNG ping Firestore mỗi request — trước đây mỗi lần gọi
// là 1 read Firestore, dễ bị lạm dụng làm cạn quota (dự án từng RESOURCE_EXHAUSTED).
app.get("/health", (req, res) => {
    res.json({
        success: true,
        message: "LumiShow API đang hoạt động"
    });
});


// Error handler cuối cùng — trả JSON gọn, KHÔNG lộ stack trace/thông tin nội
// bộ ra client dù NODE_ENV là gì. Lỗi CORS (status 403) trả đúng 403.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
        console.error("LỖI SERVER:", err);
    }
    res.status(status).json({
        success: false,
        message: status === 403
            ? "Truy cập không được phép"
            : "Đã có lỗi xảy ra, vui lòng thử lại."
    });
});


app.listen(PORT, () => {
    console.log(`LumiShow API đang chạy tại port ${PORT}`);
});