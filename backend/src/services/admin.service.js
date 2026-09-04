const { db } = require("../config/firebase");

// ==========================================
// PIN ADMIN — kiểm tra ở SERVER, không hardcode trong app Unity (APK có
// thể decompile lấy ra chuỗi cứng). Đổi được qua .env mà không cần build
// lại app. Không set biến này thì dùng mặc định "0410205".
// ==========================================

const ADMIN_PIN = process.env.ADMIN_PIN || "0410205";

function checkPin(pin) {
    return typeof pin === "string" && pin === ADMIN_PIN;
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

module.exports = {
    checkPin,
    cancelTicketBySeat,
    createManualTicket
};
