const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { db } = require("./config/firebase");

const bookingRoutes = require("./routes/booking.routes");
const paymentRoutes = require("./routes/payment.routes");
const ticketRoutes = require("./routes/ticket.routes");

const app = express();

app.use(helmet());

// Giới hạn số request /api mỗi IP để chống spam gọi /seats hoặc /bookings/hold
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Quá nhiều yêu cầu, vui lòng thử lại sau."
    }
});

const allowedOrigins = [
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "https://lumishow.vn",
    "https://www.lumishow.vn",
    "https://sonthanthuyquai-ticket.web.app"
];

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

        return callback(
            new Error("Origin không được phép truy cập API"),
            false
        );
    },

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],

    allowedHeaders: [
        "Content-Type",
        "Authorization"
    ]
}));
const PORT = process.env.PORT || 3000;


app.use(express.json());

app.use("/api", apiLimiter, bookingRoutes);
app.use("/api", apiLimiter, paymentRoutes);
app.use("/api", apiLimiter, ticketRoutes);


app.get("/health", async (req, res) => {

    try {

        await db.collection("shows").limit(1).get();

        res.json({
            success: true,
            message: "LumiShow API đang hoạt động",
            firestore: "connected"
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

});


app.listen(PORT, () => {
    console.log(`LumiShow API đang chạy tại port ${PORT}`);
});