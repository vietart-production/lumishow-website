const { db } = require("../config/firebase");
const crypto = require("crypto");

const BOOKING_CONFIG = require("../config/booking.config");


// ==========================================
// CACHE NGẮN HẠN CHO TRẠNG THÁI GHẾ
// ------------------------------------------
// GET /seats đọc toàn bộ subcollection seats (hàng nghìn document mỗi lần).
// Cache vài giây để gộp các lần gọi liên tiếp (F5, auto-reload khi dev,
// đổi qua lại ngày/giờ suất diễn) thành một lần đọc Firestore duy nhất.
// Bị xoá ngay khi có hold mới hoặc hold hết hạn được giải phóng, nên
// không ảnh hưởng tới tính đúng đắn của giao dịch giữ ghế (transaction
// vẫn luôn đọc dữ liệu Firestore mới nhất, không dùng cache).
// ==========================================

const SEATS_CACHE_TTL_MS = 5 * 1000;
const seatsCache = new Map();

function seatsCacheKey(showId, showtimeId) {
    return `${showId}/${showtimeId}`;
}

function invalidateSeatsCache(showId, showtimeId) {
    seatsCache.delete(seatsCacheKey(showId, showtimeId));
}


async function getSeatStates(showId, showtimeId) {

    const cacheKey = seatsCacheKey(showId, showtimeId);
    const cached = seatsCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }

    await cleanupExpiredHoldsThrottled();
    const seatsSnapshot = await db
        .collection("shows")
        .doc(showId)
        .collection("showtimes")
        .doc(showtimeId)
        .collection("seats")
        .get();


    if (seatsSnapshot.empty) {
        throw new Error("Không tìm thấy dữ liệu ghế cho suất diễn này");
    }


    const seats = {};


    seatsSnapshot.forEach((doc) => {

        const data = doc.data();

        seats[doc.id] = {
            status: data.status
        };

    });


    seatsCache.set(cacheKey, {
        data: seats,
        expiresAt: Date.now() + SEATS_CACHE_TTL_MS
    });

    return seats;
}

// ==========================================
// KIỂM TRA TRẠNG THÁI MỘT HOLD
// ------------------------------------------
// Dùng để client khôi phục phiên giữ ghế sau khi reload trang (theo đúng
// pattern hold-token của các hệ thống vé thật: không tự coi ghế là "trống"
// hay "của người khác" sau reload, mà hỏi lại server hold còn hiệu lực
// không). Chỉ đọc, không ghi — 1 document read mỗi lần gọi.
// ==========================================

async function getHoldStatus(holdId) {

    const holdDoc = await db
        .collection("holds")
        .doc(holdId)
        .get();

    if (!holdDoc.exists) {
        return { status: "NOT_FOUND" };
    }

    const holdData = holdDoc.data();
    const expiresAt = holdData.expiresAt?.toDate
        ? holdData.expiresAt.toDate()
        : new Date(holdData.expiresAt);

    if (holdData.status !== "ACTIVE" || !expiresAt || expiresAt <= new Date()) {
        return { status: "EXPIRED" };
    }

    return {
        status: "ACTIVE",
        holdId,
        showId: holdData.showId,
        showtimeId: holdData.showtimeId,
        seatIds: holdData.seatIds || [],
        expiresAt
    };
}

// ==========================================
// GIỮ GHẾ BẰNG FIRESTORE TRANSACTION
// ==========================================

async function createHold({
    showId,
    showtimeId,
    seatIds,
    bookingSessionId
}) {

    // Validate cơ bản
    if (
        !showId ||
        !showtimeId ||
        !Array.isArray(seatIds) ||
        !bookingSessionId
    ) {
        throw new Error("Dữ liệu giữ ghế không hợp lệ");
    }


    // Không cho danh sách ghế rỗng
    if (seatIds.length === 0) {
        throw new Error("Bạn chưa chọn ghế");
    }
    await cleanupExpiredHoldsThrottled();

    // Không cho vượt quá giới hạn
    if (seatIds.length > BOOKING_CONFIG.MAX_SEATS_PER_ORDER) {
        throw new Error(
            `Mỗi lượt chỉ được đặt tối đa ${BOOKING_CONFIG.MAX_SEATS_PER_ORDER} ghế`
        );
    }


    // Chống gửi trùng cùng một ghế nhiều lần
    const uniqueSeatIds = [...new Set(seatIds)];

    if (uniqueSeatIds.length !== seatIds.length) {
        throw new Error("Danh sách ghế có dữ liệu trùng lặp");
    }


    // Tạo ID hold an toàn
    const holdId = `hold_${crypto.randomUUID()}`;


    const now = new Date();

    const expiresAt = new Date(
        now.getTime() + BOOKING_CONFIG.HOLD_DURATION_MS
    );


    const holdRef = db
        .collection("holds")
        .doc(holdId);


    const showtimeRef = db
        .collection("shows")
        .doc(showId)
        .collection("showtimes")
        .doc(showtimeId);


    const seatRefs = uniqueSeatIds.map((seatId) =>
        showtimeRef
            .collection("seats")
            .doc(seatId)
    );


    await db.runTransaction(async (transaction) => {

        // ==========================================
        // 1. Kiểm tra showtime có tồn tại không
        // ==========================================

        const showtimeDoc = await transaction.get(showtimeRef);

        if (!showtimeDoc.exists) {
            throw new Error("Không tìm thấy suất diễn");
        }


        const showtimeData = showtimeDoc.data();

        if (showtimeData.status !== "OPEN") {
            throw new Error("Suất diễn hiện không mở bán");
        }


        // ==========================================
        // 2. Đọc tất cả ghế trước khi ghi bất cứ thứ gì
        // ==========================================

        const seatDocs = await Promise.all(
            seatRefs.map((seatRef) =>
                transaction.get(seatRef)
            )
        );


        // ==========================================
        // 3. Kiểm tra từng ghế
        // ==========================================

        for (let i = 0; i < seatDocs.length; i++) {

            const seatDoc = seatDocs[i];
            const seatId = uniqueSeatIds[i];


            if (!seatDoc.exists) {
                throw new Error(
                    `Ghế ${seatId} không tồn tại`
                );
            }


            const seatData = seatDoc.data();


            if (seatData.status !== "AVAILABLE") {
                throw new Error(
                    `Ghế ${seatId} không còn trống`
                );
            }
        }


        // ==========================================
        // 4. Tạo HOLD
        // ==========================================

        transaction.set(holdRef, {
            bookingSessionId,

            showId,
            showtimeId,

            seatIds: uniqueSeatIds,

            status: "ACTIVE",

            expiresAt,

            createdAt: now,
            updatedAt: now
        });


        // ==========================================
        // 5. Chuyển ghế thành HELD
        // ==========================================

        for (const seatRef of seatRefs) {

            transaction.update(seatRef, {
                status: "HELD",

                holdId,

                holdExpiresAt: expiresAt,

                updatedAt: now
            });
        }
    });

    invalidateSeatsCache(showId, showtimeId);

    return {
        holdId,
        expiresAt,
        seatIds: uniqueSeatIds
    };
}

// ==========================================
// GIẢI PHÓNG MỘT HOLD ĐÃ HẾT HẠN
// ==========================================

async function releaseExpiredHold(holdId) {

    const holdRef = db
        .collection("holds")
        .doc(holdId);

    let releasedShow = null;

    await db.runTransaction(async (transaction) => {

        const holdDoc = await transaction.get(holdRef);


        // Hold không tồn tại
        if (!holdDoc.exists) {
            return;
        }


        const holdData = holdDoc.data();


        // Chỉ xử lý hold đang ACTIVE
        if (holdData.status !== "ACTIVE") {
            return;
        }


        const now = new Date();
        const expiresAt = holdData.expiresAt?.toDate();


        // Chưa hết hạn thì không làm gì
        if (!expiresAt || expiresAt > now) {
            return;
        }


        const {
            showId,
            showtimeId,
            seatIds = []
        } = holdData;

        releasedShow = { showId, showtimeId };


        const showtimeRef = db
            .collection("shows")
            .doc(showId)
            .collection("showtimes")
            .doc(showtimeId);


        const seatRefs = seatIds.map((seatId) =>
            showtimeRef
                .collection("seats")
                .doc(seatId)
        );


        // Đọc ghế
        const seatDocs = await Promise.all(
            seatRefs.map((seatRef) =>
                transaction.get(seatRef)
            )
        );


        // Chỉ giải phóng ghế nếu ghế vẫn thuộc chính hold này
        for (let i = 0; i < seatDocs.length; i++) {

            const seatDoc = seatDocs[i];
            const seatRef = seatRefs[i];

            if (!seatDoc.exists) {
                continue;
            }


            const seatData = seatDoc.data();


            if (
                seatData.status === "HELD" &&
                seatData.holdId === holdId
            ) {

                transaction.update(seatRef, {
                    status: "AVAILABLE",

                    holdId: null,

                    holdExpiresAt: null,

                    updatedAt: now
                });
            }
        }


        // Đánh dấu hold đã hết hạn
        transaction.update(holdRef, {
            status: "EXPIRED",

            updatedAt: now
        });
    });

    if (releasedShow) {
        invalidateSeatsCache(releasedShow.showId, releasedShow.showtimeId);
    }
}

// ==========================================
// DỌN CÁC HOLD ĐÃ HẾT HẠN
// ==========================================

async function cleanupExpiredHolds() {

    const now = new Date();


    const expiredSnapshot = await db
        .collection("holds")
        .where("status", "==", "ACTIVE")
        .where("expiresAt", "<=", now)
        .limit(50)
        .get();


    if (expiredSnapshot.empty) {
        return 0;
    }


    let releasedCount = 0;


    for (const holdDoc of expiredSnapshot.docs) {

        await releaseExpiredHold(holdDoc.id);

        releasedCount++;
    }


    return releasedCount;
}

// ==========================================
// GIỚI HẠN TẦN SUẤT DỌN HOLD HẾT HẠN
// ------------------------------------------
// cleanupExpiredHolds() quét toàn bộ collection holds (không riêng theo
// suất diễn), nên không cần chạy lại trên mỗi request GET /seats hay
// POST /bookings/hold. Giới hạn tối đa 1 lần mỗi 15 giây là đủ để hold
// hết hạn được dọn kịp thời mà không tốn thêm reads mỗi request.
// ==========================================

const CLEANUP_MIN_INTERVAL_MS = 15 * 1000;
let lastCleanupAt = 0;

async function cleanupExpiredHoldsThrottled() {

    const now = Date.now();

    if (now - lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) {
        return 0;
    }

    lastCleanupAt = now;

    return cleanupExpiredHolds();
}

module.exports = {
    getSeatStates,
    getHoldStatus,
    createHold,
    releaseExpiredHold,
    cleanupExpiredHolds
};