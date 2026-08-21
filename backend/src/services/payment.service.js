const path = require("path");

require("dotenv").config({
    path: path.resolve(__dirname, "../../.env")
});

const { PayOS } = require("@payos/node");
const crypto = require("crypto");
const QRCode = require("qrcode");

const { db } = require("../config/firebase");
const { getHoldStatus } = require("./booking.service");

const payos = new PayOS({
    clientId: process.env.PAYOS_CLIENT_ID,
    apiKey: process.env.PAYOS_API_KEY,
    checksumKey: process.env.PAYOS_CHECKSUM_KEY
});

const FRONTEND_URL = process.env.FRONTEND_URL || "http://127.0.0.1:5500";


// ==========================================
// TẠO ĐƠN HÀNG + PAYMENT LINK CHO MỘT HOLD
// ------------------------------------------
// Giá luôn tính lại từ Firestore (giá ghế thật), không tin số tiền
// client gửi lên. Chỉ tạo được payment link nếu hold còn ACTIVE.
// ==========================================

async function createPaymentForHold({
    holdId,
    customerName,
    customerPhone,
    customerEmail
}) {

    if (!holdId || !customerName || !customerPhone || !customerEmail) {
        throw new Error("Thiếu thông tin tạo thanh toán");
    }

    const hold = await getHoldStatus(holdId);

    if (hold.status !== "ACTIVE") {
        throw new Error("Phiên giữ ghế không còn hiệu lực, vui lòng chọn ghế lại");
    }

    const showtimeRef = db
        .collection("shows")
        .doc(hold.showId)
        .collection("showtimes")
        .doc(hold.showtimeId);

    const seatRefs = hold.seatIds.map((seatId) =>
        showtimeRef
            .collection("seats")
            .doc(seatId)
    );

    const seatDocs = await Promise.all(
        seatRefs.map((ref) => ref.get())
    );

    let amount = 0;

    seatDocs.forEach((doc, i) => {

        if (!doc.exists) {
            throw new Error(`Ghế ${hold.seatIds[i]} không tồn tại`);
        }

        amount += doc.data().price;
    });

    const orderCode = Date.now();
    const orderId = `order_${crypto.randomUUID()}`;
    const orderRef = db.collection("orders").doc(orderId);

    const now = new Date();

    await orderRef.set({
        holdId,

        showId: hold.showId,
        showtimeId: hold.showtimeId,
        seatIds: hold.seatIds,

        orderCode,
        amount,

        customerName,
        customerPhone,
        customerEmail,

        orderStatus: "PENDING_PAYMENT",
        paymentStatus: "PENDING",

        createdAt: now,
        updatedAt: now
    });

    let paymentLink;

    try {

        paymentLink = await payos.paymentRequests.create({
            orderCode,
            amount,
            description: `LumiShow ${orderCode}`,
            buyerName: customerName,
            buyerPhone: customerPhone,
            buyerEmail: customerEmail,
            cancelUrl: `${FRONTEND_URL}/BookingTicket.html`,
            returnUrl: `${FRONTEND_URL}/BookingTicket.html`
        });

    } catch (error) {

        // Tạo payment link thất bại — đánh dấu order huỷ, không để đơn treo lơ lửng
        await orderRef.update({
            orderStatus: "CANCELLED",
            paymentStatus: "FAILED",
            updatedAt: new Date()
        });

        throw error;
    }

    // paymentLink.qrCode là chuỗi nội dung QR (chuẩn VietQR), không phải ảnh —
    // tự vẽ ảnh PNG ở backend để frontend hiện QR trực tiếp, không cần gọi
    // dịch vụ QR bên thứ ba (tránh lộ nội dung thanh toán ra ngoài).
    const qrCodeDataUrl = await QRCode.toDataURL(paymentLink.qrCode, {
        margin: 1,
        width: 320
    });

    await orderRef.update({
        paymentLinkId: paymentLink.paymentLinkId,
        checkoutUrl: paymentLink.checkoutUrl,
        qrCode: paymentLink.qrCode,
        updatedAt: new Date()
    });

    return {
        orderId,
        orderCode,
        amount,
        checkoutUrl: paymentLink.checkoutUrl,
        qrCode: paymentLink.qrCode,
        qrCodeDataUrl
    };
}

// ==========================================
// CHỐT ĐƠN THÀNH PAID (dùng chung cho cả webhook lẫn poll)
// ------------------------------------------
// Idempotent: kiểm tra orderStatus bên trong transaction nên gọi lại
// nhiều lần (webhook retry, hoặc poll trùng lúc webhook tới) không xử lý
// trùng, không tạo vé đôi.
// ==========================================

async function finalizeOrderAsPaid(orderRef) {

    let alreadyPaid = false;

    await db.runTransaction(async (transaction) => {

        // ==========================================
        // 1. Đọc tất cả trước khi ghi (order, hold, ghế)
        // ==========================================

        const orderSnap = await transaction.get(orderRef);
        const order = orderSnap.data();

        if (order.orderStatus === "PAID") {
            alreadyPaid = true;
            return;
        }

        const holdRef = db.collection("holds").doc(order.holdId);
        const holdSnap = await transaction.get(holdRef);

        const showtimeRef = db
            .collection("shows")
            .doc(order.showId)
            .collection("showtimes")
            .doc(order.showtimeId);

        const seatRefs = order.seatIds.map((seatId) =>
            showtimeRef
                .collection("seats")
                .doc(seatId)
        );

        const seatDocs = await Promise.all(
            seatRefs.map((ref) => transaction.get(ref))
        );

        const now = new Date();

        // ==========================================
        // 2. Order → PAID
        // ==========================================

        transaction.update(orderRef, {
            orderStatus: "PAID",
            paymentStatus: "PAID",
            paidAt: now,
            updatedAt: now
        });

        // ==========================================
        // 3. Hold → COMPLETED
        // ==========================================

        if (holdSnap.exists) {
            transaction.update(holdRef, {
                status: "COMPLETED",
                updatedAt: now
            });
        }

        // ==========================================
        // 4. Ghế → SOLD, tạo vé cho từng ghế
        // ==========================================

        seatDocs.forEach((seatDoc, i) => {

            if (!seatDoc.exists) {
                return;
            }

            const seatData = seatDoc.data();

            transaction.update(seatRefs[i], {
                status: "SOLD",
                holdId: null,
                holdExpiresAt: null,
                updatedAt: now
            });

            const ticketRef = db.collection("tickets").doc();

            transaction.set(ticketRef, {
                orderId: orderRef.id,

                showId: order.showId,
                showtimeId: order.showtimeId,
                seatId: order.seatIds[i],

                customerName: order.customerName,
                customerPhone: order.customerPhone,

                price: seatData.price,

                paymentStatus: "paid",
                ticketStatus: "valid",
                ticketCode: `LS-${order.orderCode}-${order.seatIds[i]}`,

                checkedIn: false,
                checkedInAt: null,

                createdAt: now
            });
        });
    });

    return alreadyPaid;
}

// ==========================================
// XỬ LÝ WEBHOOK THANH TOÁN TỪ PAYOS
// ------------------------------------------
// payos.webhooks.verify() tự kiểm tra chữ ký/checksum — throw nếu payload
// giả mạo hoặc sai. Chỉ dùng được khi đã có domain công khai đăng ký với
// PayOS (payos.webhooks.confirm()) — trước đó dùng getPaymentStatus() poll.
// ==========================================

async function handlePaymentWebhook(webhookBody) {

    const webhookData = await payos.webhooks.verify(webhookBody);

    const ordersSnapshot = await db
        .collection("orders")
        .where("orderCode", "==", webhookData.orderCode)
        .limit(1)
        .get();

    if (ordersSnapshot.empty) {
        throw new Error(`Không tìm thấy đơn hàng cho orderCode ${webhookData.orderCode}`);
    }

    const orderRef = ordersSnapshot.docs[0].ref;

    // Thanh toán không thành công (code khác "00") — không chuyển ghế/tạo vé
    if (webhookData.code !== "00") {
        return { handled: false, reason: "payment_not_successful" };
    }

    const alreadyPaid = await finalizeOrderAsPaid(orderRef);

    return { handled: true, alreadyPaid };
}

// ==========================================
// KIỂM TRA TRẠNG THÁI ĐƠN (POLL) — dùng khi CHƯA có domain để nhận webhook
// ------------------------------------------
// Hỏi thẳng PayOS qua payos.paymentRequests.get(orderCode) thay vì chờ
// PayOS gọi ngược lại — không cần HTTPS công khai. Nếu PayOS báo đã PAID
// thì chốt đơn bằng đúng transaction dùng chung với webhook (idempotent).
// ==========================================

async function getPaymentStatus(orderId) {

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
        throw new Error("Không tìm thấy đơn hàng");
    }

    const order = orderSnap.data();

    if (order.orderStatus === "PAID") {
        return { orderStatus: "PAID", paymentStatus: "PAID" };
    }

    const paymentLink = await payos.paymentRequests.get(order.orderCode);

    if (paymentLink.status === "PAID") {
        await finalizeOrderAsPaid(orderRef);
        return { orderStatus: "PAID", paymentStatus: "PAID" };
    }

    // Đồng bộ trạng thái PayOS về Firestore để tiện theo dõi, không đụng ghế
    if (paymentLink.status !== order.paymentStatus) {
        await orderRef.update({
            paymentStatus: paymentLink.status,
            updatedAt: new Date()
        });
    }

    return { orderStatus: order.orderStatus, paymentStatus: paymentLink.status };
}

module.exports = {
    createPaymentForHold,
    handlePaymentWebhook,
    getPaymentStatus
};
