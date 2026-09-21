const crypto = require("crypto");
const { db } = require("../config/firebase");
const { FieldPath } = require("firebase-admin/firestore");
const BOOKING_CONFIG = require("../config/booking.config");
const { sendTicketEmail } = require("./email.service");

const DOW_NAMES = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];

// Chỉ cho phép mã ghế dạng {hàng}{số}: 1-2 chữ cái hoa + 1-3 số (vd B12, AB9).
// Chặn chuỗi độc hại (path injection kiểu "../..") lọt vào đường dẫn Firestore.
const SEAT_ID_RE = /^[A-Z]{1,2}\d{1,3}$/;

// ==========================================
// PIN ADMIN — kiểm tra ở SERVER, không hardcode trong app Unity (APK có
// thể decompile lấy ra chuỗi cứng). Đổi được qua .env mà không cần build
// lại app.
// LƯU Ý VẬN HÀNH: nên đặt biến ADMIN_PIN trên Render bằng một chuỗi DÀI, ngẫu
// nhiên (không phải ngày sinh) — giá trị mặc định dưới đây chỉ là để dev/không
// crash khi thiếu env, KHÔNG an toàn nếu repo công khai.
// ==========================================

const ADMIN_PIN = process.env.ADMIN_PIN || "0410205";

// So sánh hằng-thời-gian để không rò rỉ độ dài/nội dung PIN qua thời gian phản
// hồi (timing attack). Khác độ dài cũng trả false mà không so từng ký tự.
function checkPin(pin) {
    if (typeof pin !== "string") return false;
    const a = Buffer.from(pin);
    const b = Buffer.from(ADMIN_PIN);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ==========================================
// HỦY VÉ THEO GHẾ — dùng khi nhân viên tại cổng cần thu hồi 1 vé đã bán
// (vé lỗi, khách đổi ý, gian lận...). Không xoá hẳn document — chuyển
// ticketStatus sang "cancelled" để vẫn còn dấu vết đối soát sau này, đồng
// thời trả ghế về AVAILABLE để bán lại được.
// ==========================================

async function cancelTicketBySeat({ showId, showtimeId, seatId }) {

    if (!showId || !showtimeId || !seatId) {
        throw new Error("Thiếu showId/showtimeId/seatId");
    }

    if (!SEAT_ID_RE.test(seatId)) {
        throw new Error("Mã ghế không hợp lệ");
    }

    const ticketsSnap = await db.collection("tickets")
        .where("showId", "==", showId)
        .where("showtimeId", "==", showtimeId)
        .where("seatId", "==", seatId)
        .where("ticketStatus", "==", "valid")
        .limit(1)
        .get();

    if (ticketsSnap.empty) {
        throw new Error(`Không tìm thấy vé đang hợp lệ cho ghế ${seatId}`);
    }

    const ticketRef = ticketsSnap.docs[0].ref;

    const seatRef = db
        .collection("shows").doc(showId)
        .collection("showtimes").doc(showtimeId)
        .collection("seats").doc(seatId);

    const now = new Date();

    await db.runTransaction(async (transaction) => {

        const ticketSnap = await transaction.get(ticketRef);
        const seatSnap = await transaction.get(seatRef);

        if (!ticketSnap.exists || ticketSnap.data().ticketStatus !== "valid") {
            throw new Error("Vé đã bị huỷ hoặc không còn hợp lệ");
        }

        // Không cho huỷ vé đã check-in (khách đã vào rạp) — tránh nhân viên huỷ
        // vé đang dùng rồi bán lại ghế, và tránh sai lệch số liệu soát vé.
        if (ticketSnap.data().checkedIn === true) {
            throw new Error("Vé đã được check-in (khách đã vào rạp), không thể huỷ");
        }

        transaction.update(ticketRef, {
            ticketStatus: "cancelled",
            cancelledAt: now,
            cancelledBy: "admin-panel"
        });

        if (seatSnap.exists) {
            transaction.update(seatRef, {
                status: "AVAILABLE",
                holdId: null,
                holdExpiresAt: null,
                updatedAt: now
            });
        }
    });

    const ticketData = ticketsSnap.docs[0].data();

    return {
        ticketCode: ticketData.ticketCode,
        seatId,
        customerName: ticketData.customerName || ""
    };
}

// ==========================================
// TẠO VÉ THỦ CÔNG — bán tay/tiền mặt tại cổng. Giá/hạng lấy đúng từ dữ
// liệu ghế thật trong Firestore (không cho nhân viên tự gõ giá), tự sinh
// ticketCode + để checkedIn=false (vẫn phải quét vào cửa như vé thường).
// ==========================================

async function createManualTicket({
    showId,
    showtimeId,
    seatId,
    customerName,
    customerPhone,
    customerEmail
}) {



    if (!showId || !showtimeId || !seatId || !customerName) {
        throw new Error("Thiếu showId/showtimeId/seatId/customerName");
    }

    if (!SEAT_ID_RE.test(seatId)) {
        throw new Error("Mã ghế không hợp lệ");
    }

    const seatRef = db
        .collection("shows").doc(showId)
        .collection("showtimes").doc(showtimeId)
        .collection("seats").doc(seatId);

    const orderCode = Date.now();
    const ticketCode = `LS-${orderCode}-${seatId}`;
    const now = new Date();

    const orderRef = db.collection("orders").doc();
    const ticketRef = db.collection("tickets").doc();

    let seatPrice = null;
    let seatTierName = null;

    await db.runTransaction(async (transaction) => {

        const seatSnap = await transaction.get(seatRef);

        if (!seatSnap.exists) {
            throw new Error(`Ghế ${seatId} không tồn tại`);
        }

        const seatData = seatSnap.data();
        seatPrice = seatData.price;
        seatTierName = seatData.tierName;

        if (seatData.status !== "AVAILABLE") {
            throw new Error(`Ghế ${seatId} không còn trống (đang ${seatData.status})`);
        }

        transaction.update(seatRef, {
            status: "SOLD",
            holdId: null,
            holdExpiresAt: null,
            updatedAt: now
        });

        transaction.set(orderRef, {
            showId,
            showtimeId,
            seatIds: [seatId],

            customerName,
            customerPhone: customerPhone || "",
            customerEmail: customerEmail || "",

            amount: seatData.price,

            orderStatus: "PAID",
            paymentStatus: "PAID",
            paymentMethod: "cash",
            source: "manual",

            orderCode,

            createdAt: now,
            paidAt: now,
            updatedAt: now
        });

        transaction.set(ticketRef, {
            orderId: orderRef.id,

            showId,
            showtimeId,
            seatId,

            customerName,
            customerPhone: customerPhone || "",
            customerEmail: customerEmail || "",

            price: seatData.price,
            tier: seatData.tier,
            tierName: seatData.tierName,

            paymentStatus: "paid",
            ticketStatus: "valid",
            ticketCode,
            source: "manual",

            checkedIn: false,
            checkedInAt: null,

            createdAt: now
        });
    });

    return {
        ticketCode,
        seatId,
        tierName: seatTierName,
        price: seatPrice,
        customerName
    };
}

// ==========================================
// LIỆT KÊ SUẤT DIỄN SẮP TỚI — cho app Unity chọn thay vì nhân viên phải tự
// tính lịch/gõ tay showtimeId. Mùa diễn kéo dài nhiều tháng, mỗi ngày trong
// tuần có giờ diễn riêng (xem seedSeats.js), không thể hardcode 1 suất cố
// định như trước nữa. showtimeId dạng "YYYY-MM-DD_HH:MM" nên so sánh chuỗi
// == so sánh thời gian thật, dùng thẳng documentId() để sắp xếp/lọc, không
// cần field ngày riêng hay composite index.
// ==========================================

function formatShowtimeLabel(showtimeId) {

    const [datePart, timePart] = showtimeId.split("_");
    const [y, m, d] = datePart.split("-").map(Number);
    const date = new Date(y, m - 1, d);

    const dow = DOW_NAMES[date.getDay()];
    const dd = String(d).padStart(2, "0");
    const mm = String(m).padStart(2, "0");

    return `${dow}, ${dd}/${mm}/${y} · ${timePart}`;
}

async function listUpcomingShowtimes({ showId, limit = 10 }) {

    if (!showId) {
        throw new Error("Thiếu showId");
    }

    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const snap = await db
        .collection("shows").doc(showId)
        .collection("showtimes")
        .orderBy(FieldPath.documentId())
        .startAt(todayKey)
        .limit(limit)
        .get();

    return snap.docs.map((doc) => ({
        showtimeId: doc.id,
        label: formatShowtimeLabel(doc.id)
    }));
}

// ==========================================
// XOÁ ĐƠN HÀNG — dùng khi phát hiện đơn rác/test (không phải khách thật).
// Xoá hẳn document order + mọi ticket liên quan, trả ghế về AVAILABLE.
// KHÔNG dùng cho đơn khách thật muốn huỷ — trường hợp đó dùng
// cancelTicketBySeat() (giữ dấu vết ticketStatus="cancelled" để đối soát),
// hàm này xoá vĩnh viễn, không hoàn tác được.
// ==========================================

async function deleteOrder({ showId, orderId }) {

    if (!orderId) {
        throw new Error("Thiếu orderId");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
        throw new Error("Không tìm thấy đơn hàng");
    }

    const order = orderSnap.data();

    if (order.showId && order.showId !== showId) {
        throw new Error("Đơn hàng không thuộc show này");
    }

    const batch = db.batch();
    batch.delete(orderRef);

    let releasedSeats = 0;
    const skippedSeats = [];

    if (order.showtimeId && Array.isArray(order.seatIds) && order.seatIds.length > 0) {

        const seatsRef = db.collection("shows").doc(showId)
            .collection("showtimes").doc(order.showtimeId)
            .collection("seats");

        // Trước khi trả ghế về AVAILABLE, kiểm tra ghế đó có đang được giữ bởi 1 vé
        // "valid" CỦA ĐƠN KHÁC hay không (VD: xoá 1 đơn rác/test mà tình cờ trùng
        // seatId với 1 đơn thật đã bán ghế đó sau này) — nếu có thì bỏ qua ghế đó,
        // không ghi đè mất trạng thái SOLD hợp lệ của đơn khác. Đã xảy ra thật
        // (ghế B8, suất 2026-09-26_16:30, bị reset AVAILABLE dù đã bán cho khách
        // khác — phát hiện và vá 2026-09-18). Dùng đúng composite index sẵn có
        // (showId, showtimeId, seatId, ticketStatus) trong firestore.indexes.json.
        const ownershipChecks = await Promise.all(
            order.seatIds.map((seatId) =>
                db.collection("tickets")
                    .where("showId", "==", showId)
                    .where("showtimeId", "==", order.showtimeId)
                    .where("seatId", "==", seatId)
                    .where("ticketStatus", "==", "valid")
                    .get()
            )
        );

        order.seatIds.forEach((seatId, i) => {

            const ownedByOther = ownershipChecks[i].docs.some((t) => t.data().orderId !== orderId);

            if (ownedByOther) {
                skippedSeats.push(seatId);
                return;
            }

            releasedSeats++;
            batch.update(seatsRef.doc(seatId), {
                status: "AVAILABLE",
                holdId: null,
                holdExpiresAt: null,
                updatedAt: new Date()
            });
        });
    }

    const ticketsSnap = await db.collection("tickets").where("orderId", "==", orderId).get();
    ticketsSnap.docs.forEach((t) => batch.delete(t.ref));

    await batch.commit();

    return {
        orderId,
        deletedTickets: ticketsSnap.size,
        releasedSeats,
        skippedSeats
    };
}

// ==========================================
// SỬA THÔNG TIN KHÁCH TRÊN ĐƠN HÀNG — sửa nhầm tên/SĐT/email lúc đặt tay,
// hoặc khách báo sai thông tin cần đính chính. Cập nhật cả order lẫn mọi
// ticket liên quan (denormalized customerName/Phone/Email trên ticket để
// khỏi phải join sang order lúc soát vé) để không bị lệch dữ liệu.
// ==========================================

async function updateOrderCustomerInfo({ showId, orderId, customerName, customerPhone, customerEmail }) {

    if (!orderId) {
        throw new Error("Thiếu orderId");
    }

    const fields = {};
    if (customerName !== undefined) fields.customerName = String(customerName).trim();
    if (customerPhone !== undefined) fields.customerPhone = String(customerPhone).trim();
    if (customerEmail !== undefined) fields.customerEmail = String(customerEmail).trim();

    if (Object.keys(fields).length === 0) {
        throw new Error("Không có gì để cập nhật");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
        throw new Error("Không tìm thấy đơn hàng");
    }

    const order = orderSnap.data();

    if (order.showId && order.showId !== showId) {
        throw new Error("Đơn hàng không thuộc show này");
    }

    const now = new Date();
    const batch = db.batch();
    batch.update(orderRef, { ...fields, updatedAt: now });

    const ticketsSnap = await db.collection("tickets").where("orderId", "==", orderId).get();
    ticketsSnap.docs.forEach((t) => batch.update(t.ref, { ...fields, updatedAt: now }));

    await batch.commit();

    return { orderId, updatedFields: Object.keys(fields), updatedTickets: ticketsSnap.size };
}

async function findOrderByCode({ showId, orderCode }) {
    if (!String(orderCode || "").trim()) throw new Error("Thiếu mã đơn");

    let snap = await db.collection("orders").where("orderCode", "==", Number(orderCode)).limit(2).get();
    if (snap.empty) snap = await db.collection("orders").where("orderCode", "==", String(orderCode)).limit(2).get();
    if (snap.empty) throw new Error("Không tìm thấy đơn hàng");
    if (snap.size > 1) throw new Error("Mã đơn không duy nhất, cần kiểm tra dữ liệu");

    const orderDoc = snap.docs[0];
    const order = orderDoc.data();
    if (order.showId && order.showId !== showId) throw new Error("Đơn hàng không thuộc show này");

    const tickets = await db.collection("tickets").where("orderId", "==", orderDoc.id).get();
    return {
        orderId: orderDoc.id,
        orderCode: order.orderCode,
        showtimeId: order.showtimeId,
        seatIds: order.seatIds || [],
        customerName: order.customerName || "",
        customerPhone: order.customerPhone || "",
        customerEmail: order.customerEmail || "",
        amount: order.amount || 0,
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        tickets: tickets.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    };
}

async function resendOrderTicketEmail({ showId, orderId }) {
    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) throw new Error("Không tìm thấy đơn hàng");
    const order = orderSnap.data();
    if (order.showId && order.showId !== showId) throw new Error("Đơn hàng không thuộc show này");
    const tickets = await db.collection("tickets").where("orderId", "==", orderId)
        .where("ticketStatus", "==", "valid").get();
    if (tickets.empty) throw new Error("Đơn hàng không có vé hợp lệ để gửi");
    if (!order.customerEmail) throw new Error("Đơn hàng chưa có email nhận vé");
    await sendTicketEmail(order, tickets.docs.map((doc) => doc.data()));
    return { email: order.customerEmail, ticketCount: tickets.size };
}

// ==========================================
// ĐỔI SUẤT / GHẾ CHO ĐƠN ĐÃ THANH TOÁN — thay toàn bộ vé hợp lệ của đơn
// trong một transaction. Vé cũ được huỷ để QR cũ không còn hiệu lực; mỗi ghế
// mới có vé + QR mới. Không thay đổi amount vì chênh lệch do tài chính xử lý.
// ==========================================

async function exchangePaidOrderTickets({ showId, orderId, toShowtimeId, toSeatIds }) {

    if (!orderId || !toShowtimeId || !Array.isArray(toSeatIds)) {
        throw new Error("Thiếu orderId/toShowtimeId/toSeatIds");
    }

    if (toSeatIds.length === 0 || toSeatIds.length > BOOKING_CONFIG.MAX_SEATS_PER_ORDER) {
        throw new Error(`Số ghế đổi phải từ 1 đến ${BOOKING_CONFIG.MAX_SEATS_PER_ORDER}`);
    }

    if (new Set(toSeatIds).size !== toSeatIds.length || toSeatIds.some((seatId) => !SEAT_ID_RE.test(seatId))) {
        throw new Error("Danh sách ghế mới không hợp lệ hoặc bị trùng");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const ticketsSnap = await db.collection("tickets")
        .where("orderId", "==", orderId)
        .where("ticketStatus", "==", "valid")
        .get();

    if (ticketsSnap.empty) {
        throw new Error("Không tìm thấy vé hợp lệ của đơn hàng");
    }

    if (ticketsSnap.size !== toSeatIds.length) {
        throw new Error("Số ghế mới phải bằng số vé hợp lệ đang đổi");
    }

    const exchangeId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    let emailPayload;

    await db.runTransaction(async (transaction) => {

        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists) {
            throw new Error("Không tìm thấy đơn hàng");
        }

        const order = orderSnap.data();
        if (order.showId && order.showId !== showId) {
            throw new Error("Đơn hàng không thuộc show này");
        }

        if (order.orderStatus !== "PAID" || order.paymentStatus !== "PAID") {
            throw new Error("Chỉ được đổi vé của đơn đã thanh toán");
        }

        if (!Array.isArray(order.seatIds) || order.seatIds.length !== toSeatIds.length) {
            throw new Error("Dữ liệu ghế trên đơn không khớp với số vé cần đổi");
        }

        const fromShowtimeId = order.showtimeId;
        if (!fromShowtimeId) {
            throw new Error("Đơn hàng không có suất diễn");
        }

        const validTicketSnaps = await Promise.all(ticketsSnap.docs.map((doc) => transaction.get(doc.ref)));
        const validTickets = validTicketSnaps.map((snap) => snap.data());
        const fromSeatIds = validTickets.map((ticket) => ticket.seatId);

        if (validTickets.some((ticket) =>
            ticket.ticketStatus !== "valid" ||
            ticket.showId !== showId ||
            ticket.showtimeId !== fromShowtimeId ||
            ticket.checkedIn === true
        )) {
            throw new Error("Có vé không còn hợp lệ hoặc đã check-in, không thể đổi");
        }

        if (new Set(fromSeatIds).size !== fromSeatIds.length ||
            !fromSeatIds.every((seatId) => order.seatIds.includes(seatId))) {
            throw new Error("Dữ liệu vé và ghế của đơn không khớp");
        }

        const sourceSeatRefs = fromSeatIds.map((seatId) => db.collection("shows").doc(showId)
            .collection("showtimes").doc(fromShowtimeId).collection("seats").doc(seatId));
        const targetSeatRefs = toSeatIds.map((seatId) => db.collection("shows").doc(showId)
            .collection("showtimes").doc(toShowtimeId).collection("seats").doc(seatId));
        const targetShowtimeRef = db.collection("shows").doc(showId)
            .collection("showtimes").doc(toShowtimeId);
        const [sourceSeatSnaps, targetSeatSnaps] = await Promise.all([
            Promise.all(sourceSeatRefs.map((ref) => transaction.get(ref))),
            Promise.all(targetSeatRefs.map((ref) => transaction.get(ref)))]
        );

        const targetShowtimeSnap = await transaction.get(targetShowtimeRef);

        if (!targetShowtimeSnap.exists || targetShowtimeSnap.data().status !== "OPEN") {
            throw new Error("Suất diễn mới chưa mở bán");
        }

        if (sourceSeatSnaps.some((snap) => !snap.exists || snap.data().status !== "SOLD")) {
            throw new Error("Có ghế cũ không còn ở trạng thái đã bán");
        }

        if (targetSeatSnaps.some((snap) => !snap.exists || snap.data().status !== "AVAILABLE")) {
            throw new Error("Có ghế mới không tồn tại hoặc không còn trống");
        }

        const now = new Date();
        const newTickets = targetSeatSnaps.map((seatSnap, index) => {
            const seat = seatSnap.data();
            const seatId = toSeatIds[index];
            return {
                orderId,
                showId,
                showtimeId: toShowtimeId,
                seatId,
                customerName: order.customerName || "",
                customerPhone: order.customerPhone || "",
                customerEmail: order.customerEmail || "",
                price: seat.price,
                tier: seat.tier,
                tierName: seat.tierName,
                paymentStatus: "paid",
                ticketStatus: "valid",
                ticketCode: `LS-${order.orderCode}-${seatId}-${exchangeId}`,
                source: "seat-exchange",
                checkedIn: false,
                checkedInAt: null,
                createdAt: now
            };
        });

        validTicketSnaps.forEach((ticketSnap) => {
            transaction.update(ticketSnap.ref, {
                ticketStatus: "cancelled",
                cancelledAt: now,
                cancelledBy: "seat-exchange",
                cancellationReason: "Đổi suất diễn và ghế theo yêu cầu khách"
            });
        });

        sourceSeatRefs.forEach((ref) => transaction.update(ref, {
            status: "AVAILABLE",
            holdId: null,
            holdExpiresAt: null,
            updatedAt: now
        }));

        targetSeatRefs.forEach((ref) => transaction.update(ref, {
            status: "SOLD",
            holdId: null,
            holdExpiresAt: null,
            updatedAt: now
        }));

        newTickets.forEach((ticket) => transaction.set(db.collection("tickets").doc(), ticket));

        transaction.update(orderRef, {
            showtimeId: toShowtimeId,
            seatIds: toSeatIds,
            updatedAt: now,
            seatExchange: {
                fromShowtimeId,
                fromSeatIds,
                toShowtimeId,
                toSeatIds,
                exchangedAt: now,
                amountRetained: order.amount
            }
        });

        emailPayload = {
            order: { ...order, showtimeId: toShowtimeId, seatIds: toSeatIds },
            tickets: newTickets,
            cancelledTicketCodes: validTickets.map((ticket) => ticket.ticketCode)
        };
    });

    return emailPayload;
}

module.exports = {
    checkPin,
    cancelTicketBySeat,
    createManualTicket,
    exchangePaidOrderTickets,
    listUpcomingShowtimes,
    deleteOrder,
    updateOrderCustomerInfo,
    findOrderByCode,
    resendOrderTicketEmail,
    exchangePaidOrderTickets
};
