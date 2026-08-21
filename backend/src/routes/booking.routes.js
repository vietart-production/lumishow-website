const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const {
    getSeatStates,
    getHoldStatus,
    createHold
} = require("../services/booking.service");

// Giới hạn riêng, chặt hơn rate-limit chung của /api — chống 1 IP gọi
// giữ ghế liên tục để ôm nhiều lượt ghế (mỗi lượt đã giới hạn tối đa
// MAX_SEATS_PER_ORDER ghế, giới hạn này chặn việc lặp lại nhiều lượt).
const holdLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 giờ
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Bạn đã thử giữ ghế quá nhiều lần. Vui lòng thử lại sau."
    }
});

router.get(
    "/shows/:showId/showtimes/:showtimeId/seats",
    async (req, res) => {

        try {

            const {
                showId,
                showtimeId
            } = req.params;


            const seats = await getSeatStates(
                showId,
                showtimeId
            );


            return res.status(200).json({
                success: true,
                showId,
                showtimeId,
                seats
            });

        } catch (error) {

            console.error(
                "GET SEATS ERROR:",
                error
            );


            return res.status(500).json({
                success: false,
                message: error.message || "Không thể lấy trạng thái ghế"
            });

        }

    }
);

// ==========================================
// POST /api/bookings/hold
// Giữ ghế tạm thời
// ==========================================

router.post("/bookings/hold", holdLimiter, async (req, res) => {

    try {

        const {
            showId,
            showtimeId,
            seatIds,
            bookingSessionId
        } = req.body;


        const result = await createHold({
            showId,
            showtimeId,
            seatIds,
            bookingSessionId
        });


        return res.status(201).json({
            success: true,
            message: "Giữ ghế thành công",

            hold: result
        });

    } catch (error) {

        console.error(
            "CREATE HOLD ERROR:",
            error
        );


        // Ghế không còn trống hoặc dữ liệu không hợp lệ
        return res.status(400).json({
            success: false,
            message: error.message || "Không thể giữ ghế"
        });
    }

});

// ==========================================
// GET /api/bookings/hold/:holdId
// Kiểm tra một hold còn hiệu lực không — dùng để frontend khôi phục
// phiên giữ ghế sau khi reload trang.
// ==========================================

router.get("/bookings/hold/:holdId", async (req, res) => {

    try {

        const { holdId } = req.params;

        const result = await getHoldStatus(holdId);

        return res.status(200).json({
            success: true,
            ...result
        });

    } catch (error) {

        console.error(
            "GET HOLD STATUS ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message: error.message || "Không thể kiểm tra trạng thái giữ ghế"
        });

    }

});

module.exports = router;