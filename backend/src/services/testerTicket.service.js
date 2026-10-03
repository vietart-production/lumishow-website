const { db } = require("../config/firebase");
const { sendTicketEmail } = require("./email.service");
const SEAT_TIERS = require("../../scripts/seatTiers.json");

// ==========================================
// "TESTER TICKET" — công cụ nội bộ để tester đặt vé ảo, lấy QR thật, quét thử
// trên app soát vé/hệ thống check-in mà KHÔNG đụng tới dữ liệu show thật.
//
// Cách ly khỏi web thật bằng show ID RIÊNG (TEST_SHOW_ID), khác hẳn
// "son-than-thuy-quai" — mọi endpoint admin/partner thật đều hardcode show ID
// thật của họ (xem SHOW_ID trong admin.routes.js/booking.routes.js/
// partner.service.js) nên show test này tự động không xuất hiện trong bất kỳ
// báo cáo/doanh thu/soát vé nào của show thật. Vé test vẫn là document thật
// trong collection top-level "tickets" (để lookup/check-in tại cổng dùng được
// luôn, không cần sửa admin.service.js) nhưng showId khác nên không lẫn.
//
// showtimeId luôn là "{hôm nay}_TESTER" — tự tạo lại mỗi ngày (xem
// ensureTestShowtime), để classifyTicketForGate() (admin.service.js) chấm
// đúng "vé của suất diễn hôm nay" mà không cần sửa logic check-in thật.
// ==========================================

const TEST_SHOW_ID = "tester-ticket";

const SEAT_CODE_RE = /^([A-Z]+)(\d+)$/;
const SEAT_ID_RE = /^([A-Z]{1,2}\d{1,3}|VIP\d{1,2})$/;
const MAX_TEST_SEATS_PER_BATCH = 30;

const TIER_PRICES = {
    "son-than": { name: "Sơn Thần", price: 300000 },
    "thuy-quai": { name: "Thủy Quái", price: 250000 },
    "mi-nuong": { name: "Mị Nương", price: 200000 },
    "vua-hung": { name: "Vua Hùng", price: 400000 }
};

function todayTestShowtimeId() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}_TESTER`;
}

// "Full ghế" — KHÔNG áp bất kỳ quy tắc khoá nào của show thật (không G1-58
// SOLD, không khu locked-zone BLOCKED) vì đây là sơ đồ giả lập thuần kỹ
// thuật, mọi ghế phải bấm được để test.
function buildFreshTestSeats() {
    return Object.keys(SEAT_TIERS).map((seatCode) => {
        const [, row, numberStr] = seatCode.match(SEAT_CODE_RE);
        const number = parseInt(numberStr, 10);
        const tier = SEAT_TIERS[seatCode];
        const price = TIER_PRICES[tier].price;

        return {
            seatCode,
            row,
            number,
            side: number % 2 === 1 ? "odd" : "even",
            tier,
            tierName: TIER_PRICES[tier].name,
            price,
            status: "AVAILABLE",
            holdId: null,
            holdExpiresAt: null
        };
    });
}

function showtimeRefFor(showtimeId) {
    return db.collection("shows").doc(TEST_SHOW_ID)
        .collection("showtimes").doc(showtimeId);
}

async function writeSeatsInBatches(seatsCollection, seats) {
    const BATCH_SIZE = 400;
    const now = new Date();
    const writes = [];

    for (let i = 0; i < seats.length; i += BATCH_SIZE) {
        const batch = db.batch();
        seats.slice(i, i + BATCH_SIZE).forEach((seat) => {
            batch.set(seatsCollection.doc(seat.seatCode), {
                ...seat,
                createdAt: now,
                updatedAt: now
            });
        });
        writes.push(batch.commit());
    }

    await Promise.all(writes);
}

// Tạo suất test hôm nay nếu chưa có — gọi an toàn ở mọi nơi (đọc sơ đồ, tạo
// vé, reset) vì chỉ seed khi thật sự thiếu, không ghi đè nếu đã seed rồi.
async function ensureTestShowtime() {

    const showtimeId = todayTestShowtimeId();
    const showtimeRef = showtimeRefFor(showtimeId);
    const snap = await showtimeRef.get();

    if (snap.exists && snap.data().seatsSeeded === true) {
        return showtimeId;
    }

    const seats = buildFreshTestSeats();

    await showtimeRef.set({
        status: "OPEN",
        isTestFixture: true,
        seatsSeeded: true,
        seatCount: seats.length,
        createdAt: new Date()
    }, { merge: true });

    await writeSeatsInBatches(showtimeRef.collection("seats"), seats);

    return showtimeId;
}

// Nút "Reset" — ghi đè TOÀN BỘ ghế của suất test hôm nay về AVAILABLE, kể cả
// ghế đang SOLD/HELD (khác bulkUpdateSeats() của show thật: ở đây không có
// khách thật đứng sau ghế nên không cần né trạng thái nào). Lịch sử vé/ticket
// (collection "tickets"/"orders") KHÔNG bị xoá — đó là log để xem lại, không
// phải trạng thái ghế.
async function resetTestShowtime() {

    const showtimeId = todayTestShowtimeId();
    const showtimeRef = showtimeRefFor(showtimeId);
    const seats = buildFreshTestSeats();

    await showtimeRef.set({
        status: "OPEN",
        isTestFixture: true,
        seatsSeeded: true,
        seatCount: seats.length,
        resetAt: new Date()
    }, { merge: true });

    await writeSeatsInBatches(showtimeRef.collection("seats"), seats);

    return showtimeId;
}

// Tạo vé test tức thì — bỏ qua hẳn luồng giữ-ghế/thanh toán thật (không cần
// thiết cho mục đích test quét mã), mô phỏng trực tiếp kết quả cuối (ghế SOLD
// + order/ticket PAID), y hệt format dữ liệu vé thật để app soát vé xử lý
// không khác gì vé real. ticketCode có prefix "LS-TEST-" để luôn phân biệt
// được với vé thật khi lỡ nhìn thấy ở nơi khác (vd log, Firestore console).
async function createTestTicket({ seatIds, customerEmail }) {

    if (!Array.isArray(seatIds) || seatIds.length === 0) {
        throw new Error("Chưa chọn ghế nào");
    }

    if (seatIds.length > MAX_TEST_SEATS_PER_BATCH) {
        throw new Error(`Chỉ được chọn tối đa ${MAX_TEST_SEATS_PER_BATCH} ghế mỗi lượt test`);
    }

    const uniqueSeatIds = [...new Set(seatIds)];

    if (uniqueSeatIds.length !== seatIds.length) {
        throw new Error("Danh sách ghế có mã bị trùng");
    }

    if (uniqueSeatIds.some((id) => !SEAT_ID_RE.test(id))) {
        throw new Error("Có mã ghế không hợp lệ");
    }

    const showtimeId = await ensureTestShowtime();
    const showtimeRef = showtimeRefFor(showtimeId);
    const seatsCollection = showtimeRef.collection("seats");
    const seatRefs = uniqueSeatIds.map((id) => seatsCollection.doc(id));

    const orderCode = Date.now();
    const orderRef = db.collection("orders").doc();
    const now = new Date();
    const email = String(customerEmail || "").trim();

    const tickets = await db.runTransaction(async (transaction) => {

        const seatSnaps = await Promise.all(seatRefs.map((ref) => transaction.get(ref)));

        seatSnaps.forEach((snap, i) => {
            if (!snap.exists) {
                throw new Error(`Ghế ${uniqueSeatIds[i]} không tồn tại`);
            }
            if (snap.data().status !== "AVAILABLE") {
                throw new Error(`Ghế ${uniqueSeatIds[i]} đang ${snap.data().status} — bấm Reset rồi thử lại`);
            }
        });

        const ticketDocs = seatSnaps.map((snap, i) => {
            const seatId = uniqueSeatIds[i];
            const seat = snap.data();
            return {
                ref: db.collection("tickets").doc(),
                data: {
                    orderId: orderRef.id,
                    showId: TEST_SHOW_ID,
                    showtimeId,
                    seatId,
                    customerName: "Tester QR",
                    customerPhone: "",
                    customerEmail: email,
                    price: seat.price,
                    tier: seat.tier,
                    tierName: seat.tierName,
                    paymentStatus: "paid",
                    ticketStatus: "valid",
                    ticketCode: `LS-TEST-${orderCode}-${seatId}`,
                    source: "tester-tool",
                    checkedIn: false,
                    checkedInAt: null,
                    createdAt: now
                }
            };
        });

        transaction.set(orderRef, {
            showId: TEST_SHOW_ID,
            showtimeId,
            seatIds: uniqueSeatIds,
            customerName: "Tester QR",
            customerPhone: "",
            customerEmail: email,
            amount: 0,
            orderStatus: "PAID",
            paymentStatus: "PAID",
            paymentMethod: "test",
            source: "tester-tool",
            orderCode,
            createdAt: now,
            paidAt: now
        });

        seatRefs.forEach((ref) => transaction.update(ref, {
            status: "SOLD",
            holdId: null,
            holdExpiresAt: null,
            updatedAt: now
        }));

        ticketDocs.forEach((t) => transaction.set(t.ref, t.data));

        return ticketDocs.map((t) => t.data);
    });

    // Gửi mail CHỈ tới đúng email vừa điền (sendTicketEmail chỉ bao giờ gửi
    // tới order.customerEmail) — không gọi sendOrderNotificationEmail/
    // sendSeatConflictAlertEmail ở đây nên mail giám sát (ORDER_NOTIFY_EMAIL/
    // TECH_ALERT_EMAIL) không bao giờ nhận được gì từ công cụ test này.
    let emailSent = false;
    let emailError = null;

    if (email) {
        try {
            await sendTicketEmail({
                customerName: "Tester QR",
                customerPhone: "",
                customerEmail: email,
                showtimeId,
                orderCode,
                amount: 0
            }, tickets);
            emailSent = true;
        } catch (error) {
            emailError = error.message || "Gửi email thất bại";
        }
    }

    return { showtimeId, tickets, emailSent, emailError };
}

// Lịch sử mã QR test — chỉ lọc theo showId (equality đơn, không cần composite
// index mới), sắp xếp mới nhất trước trong bộ nhớ vì khối lượng vé test luôn
// nhỏ (công cụ nội bộ).
async function listTestTicketHistory({ limit = 50 } = {}) {

    const snap = await db.collection("tickets")
        .where("showId", "==", TEST_SHOW_ID)
        .limit(300)
        .get();

    const toMillis = (ts) => (ts && typeof ts.toMillis === "function") ? ts.toMillis() : 0;

    return snap.docs
        .map((doc) => doc.data())
        .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
        .slice(0, limit)
        .map((t) => ({
            ticketCode: t.ticketCode,
            seatId: t.seatId,
            showtimeId: t.showtimeId,
            customerEmail: t.customerEmail || "",
            checkedIn: t.checkedIn === true,
            checkedInAt: t.checkedInAt && t.checkedInAt.toDate ? t.checkedInAt.toDate() : null,
            createdAt: t.createdAt && t.createdAt.toDate ? t.createdAt.toDate() : null
        }));
}

module.exports = {
    TEST_SHOW_ID,
    ensureTestShowtime,
    resetTestShowtime,
    createTestTicket,
    listTestTicketHistory
};
