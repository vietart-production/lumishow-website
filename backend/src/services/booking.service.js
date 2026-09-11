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

// showtimeId dạng "YYYY-MM-DD_HH:MM" (giờ Việt Nam, UTC+7). Trả về epoch ms
// của thời điểm suất bắt đầu, hoặc null nếu format lạ (khi đó không chặn theo
// thời gian, để các lớp khác xử lý). Server Render chạy UTC nên phải trừ 7h,
// không dùng new Date(chuỗi) trực tiếp (sẽ hiểu nhầm là giờ UTC, lệch 7 tiếng).
function parseShowtimeStartMs(showtimeId) {
    const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2}):(\d{2})$/.exec(showtimeId || "");
    if (!m) return null;
    const [, y, mo, d, hh, mm] = m.map(Number);
    return Date.UTC(y, mo - 1, d, hh, mm) - 7 * 60 * 60 * 1000;
}

// Ngưng bán bao lâu TRƯỚC giờ diễn (ms). 0 = cho mua tới đúng giờ bắt đầu;
// đổi thành ví dụ 30*60*1000 nếu muốn đóng bán 30 phút trước giờ diễn.
const SALES_CUTOFF_BEFORE_START_MS = 0;

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

    // Không cho đặt vé suất đã bắt đầu / đã diễn xong. showtime chỉ có cờ
    // status="OPEN" (không có luồng nào tự đóng theo thời gian), nên phải so
    // trực tiếp với thời gian thực ở đây, nếu không khách mua nhầm vé suất đã qua.
    const startMs = parseShowtimeStartMs(showtimeId);
    if (startMs !== null && startMs - SALES_CUTOFF_BEFORE_START_MS <= Date.now()) {
        throw new Error("Suất diễn này đã bắt đầu hoặc đã kết thúc, không thể đặt vé.");
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

    // Mỗi phiên (bookingSessionId) chỉ được giữ 1 hold đang hiệu lực cùng lúc
    // (MAX_ACTIVE_HOLDS_PER_SESSION). Trước đây giới hạn này khai báo nhưng
    // không nơi nào thực thi → 1 người đổi session/gọi nhiều lần có thể khoá
    // sạch ghế cả rạp. Chạy SAU cleanup để không tính nhầm hold vừa hết hạn.
    const activeHoldsSnap = await db.collection("holds")
        .where("bookingSessionId", "==", bookingSessionId)
        .where("status", "==", "ACTIVE")
        .get();

    const nowForLimit = new Date();
    const liveHolds = activeHoldsSnap.docs.filter((doc) => {
        const exp = doc.data().expiresAt?.toDate
            ? doc.data().expiresAt.toDate()
            : new Date(doc.data().expiresAt);
        return exp && exp > nowForLimit;
    });

    if (liveHolds.length >= BOOKING_CONFIG.MAX_ACTIVE_HOLDS_PER_SESSION) {
        // Nếu phiên này đang giữ ĐÚNG những ghế đang yêu cầu (khách mất holdId
        // sau khi reload/rớt mạng rồi thử giữ lại chính ghế đó) → trả lại hold
        // cũ thay vì báo lỗi, để khách không tự khoá ghế của chính mình.
        const sameSeatsHold = liveHolds.find((doc) => {
            const s = doc.data().seatIds || [];
            return s.length === uniqueSeatIds.length
                && s.every((x) => uniqueSeatIds.includes(x));
        });

        if (sameSeatsHold) {
            const data = sameSeatsHold.data();
            return {
                holdId: sameSeatsHold.id,
                expiresAt: data.expiresAt?.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt),
                seatIds: data.seatIds
            };
        }

        throw new Error("Bạn đang có một phiên giữ ghế khác chưa hoàn tất. Vui lòng hoàn tất thanh toán hoặc chờ hết hạn rồi thử lại.");
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
        .limit(100)
        .get();


    if (expiredSnapshot.empty) {
        return 0;
    }


    // Giải phóng song song thay vì tuần tự: trước đây 50 transaction chạy nối
    // tiếp (mỗi cái ~100-200ms) khiến giờ cao điểm dọn chậm và giam ghế trống.
    // Mỗi hold là transaction độc lập nên song song an toàn; allSettled để một
    // release lỗi không làm hỏng các release còn lại.
    const results = await Promise.allSettled(
        expiredSnapshot.docs.map((holdDoc) => releaseExpiredHold(holdDoc.id))
    );

    return results.filter((r) => r.status === "fulfilled").length;
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

    // Dọn hold hết hạn là việc NỀN — một transaction release lỗi (tranh ghế,
    // deadline, Firestore hiccup) KHÔNG được phép làm hỏng request xem/giữ ghế
    // hợp lệ của khách đang gọi. Nuốt lỗi ở đây, chỉ log.
    try {
        return await cleanupExpiredHolds();
    } catch (error) {
        console.error("[cleanup] Lỗi khi dọn hold hết hạn (bỏ qua, không chặn request):", error);
        return 0;
    }
}

module.exports = {
    getSeatStates,
    getHoldStatus,
    createHold,
    releaseExpiredHold,
    cleanupExpiredHolds
};