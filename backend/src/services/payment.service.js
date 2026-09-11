const path = require("path");

require("dotenv").config({
    path: path.resolve(__dirname, "../../.env")
});

const { PayOS } = require("@payos/node");
const crypto = require("crypto");
const QRCode = require("qrcode");

const { db } = require("../config/firebase");
const { getHoldStatus } = require("./booking.service");
const { sendTicketEmail, sendOrderNotificationEmail, sendSeatConflictAlertEmail } = require("./email.service");
const { reserveCouponToAmount, releaseCouponUse } = require("./coupon.service");

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
    customerEmail,
    couponCode
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

    let subtotal = 0;

    seatDocs.forEach((doc, i) => {

        if (!doc.exists) {
            throw new Error(`Ghế ${hold.seatIds[i]} không tồn tại`);
        }

        subtotal += doc.data().price;
    });

    // Coupon (nếu có) — validate lại từ đầu ngay tại đây (không tin trạng
    // thái đã kiểm tra ở bước "Áp dụng" trước đó, coupon có thể vừa hết
    // hạn/hết lượt trong lúc khách điền form) rồi tính amount từ subtotal
    // vừa tính ở trên (giá ghế thật, không phải số client gửi).
    let amount = subtotal;
    let coupon = null;

    if (couponCode) {
        // GIỮ CHỖ lượt coupon ngay (atomic, đã tăng usedCount) thay vì chỉ đọc
        // — chặn race nhiều người cùng dùng 1 mã giới hạn lượt / mã giảm 100%.
        // Nếu các bước sau (tạo PayOS link) hỏng thì hoàn lại bằng releaseCouponUse.
        const applied = await reserveCouponToAmount(couponCode, subtotal);
        amount = applied.amount;
        coupon = {
            code: applied.code,
            percentOff: applied.percentOff,
            discount: applied.discount
        };
    }

    // orderCode gửi cho PayOS phải DUY NHẤT. Date.now() thuần có thể trùng khi
    // hai đơn tạo trong cùng mili-giây → PayOS từ chối đơn sau, webhook tra
    // nhầm đơn. Thêm 3 chữ số ngẫu nhiên (vẫn < MAX_SAFE_INTEGER).
    const orderCode = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const orderId = `order_${crypto.randomUUID()}`;
    const orderRef = db.collection("orders").doc(orderId);

    const now = new Date();

    await orderRef.set({
        holdId,

        showId: hold.showId,
        showtimeId: hold.showtimeId,
        seatIds: hold.seatIds,

        orderCode,
        subtotal,
        amount,
        coupon,

        customerName,
        customerPhone,
        customerEmail,

        orderStatus: "PENDING_PAYMENT",
        paymentStatus: "PENDING",

        createdAt: now,
        updatedAt: now
    });

    // Coupon giảm 100% — không có gì để thanh toán qua PayOS (họ không nhận
    // payment link 0đ, và về bản chất cũng không có giao dịch tiền nào cả).
    // Chốt đơn PAID ngay bằng đúng hàm transaction dùng chung với webhook/
    // poll (chuyển ghế SOLD, tạo vé, tăng usedCount coupon, gửi mail vé
    // thật) — không tự viết logic "PAID" riêng cho trường hợp này.
    if (amount === 0) {
        await finalizeOrderAsPaid(orderRef);

        return {
            orderId,
            orderCode,
            subtotal,
            amount,
            coupon,
            free: true,
            checkoutUrl: null,
            qrCode: null,
            qrCodeDataUrl: null
        };
    }

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

        // Hoàn lại lượt coupon đã giữ chỗ ở trên — đơn này không thành.
        if (coupon && coupon.code) {
            await releaseCouponUse(coupon.code);
        }

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
        subtotal,
        amount,
        coupon,
        free: false,
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

// paidAmount: số tiền THỰC NHẬN từ PayOS (webhook.amount hoặc
// paymentLink.amountPaid). Truyền vào để đối chiếu với order.amount TRONG
// transaction — chặn trường hợp khách trả thiếu tiền mà vẫn được cấp đủ vé.
// Không truyền (undefined) = bỏ qua đối chiếu, dùng cho đơn miễn phí 100%
// (không qua PayOS, không có giao dịch tiền).
async function finalizeOrderAsPaid(orderRef, paidAmount) {

    let alreadyPaid = false;
    let emailPayload = null;
    let conflictPayload = null;
    let underpaidPayload = null;

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

        // Đơn đã bị huỷ (tạo payment link lỗi trước đó) — KHÔNG hồi sinh thành
        // PAID nếu một webhook/poll trễ tới sau. Tránh gán vé cho đơn đã đóng.
        if (order.orderStatus === "CANCELLED") {
            return;
        }

        // Đối chiếu số tiền thực nhận: nếu trả thiếu, KHÔNG cấp vé — đánh dấu
        // UNDERPAID để xử lý tay (hoàn/bù). Chỉ đánh dấu 1 lần (idempotent với
        // webhook retry). paidAmount == null (đơn miễn phí) thì bỏ qua.
        if (paidAmount != null && Number(paidAmount) < Number(order.amount)) {
            if (order.paymentStatus !== "UNDERPAID") {
                transaction.update(orderRef, {
                    paymentStatus: "UNDERPAID",
                    paidAmountActual: Number(paidAmount),
                    updatedAt: new Date()
                });
                underpaidPayload = {
                    order: {
                        customerName: order.customerName,
                        customerPhone: order.customerPhone,
                        customerEmail: order.customerEmail,
                        orderCode: order.orderCode,
                        amount: order.amount,
                        showId: order.showId,
                        showtimeId: order.showtimeId
                    },
                    paidAmount: Number(paidAmount)
                };
            }
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

        // Coupon: usedCount đã được GIỮ CHỖ (tăng) atomic ngay lúc tạo payment
        // link (xem reserveCouponToAmount trong coupon.service.js), KHÔNG tăng
        // lại ở đây — tránh đếm 2 lần và tránh khe hở race đã có trước đây.

        const now = new Date();

        // ==========================================
        // 2. Phân loại từng ghế. Xung đột THẬT chỉ khi ghế đang thuộc về
        // người/đơn KHÁC: đã SOLD (khách khác đã có vé), hoặc đang HELD bởi
        // 1 hold khác (người khác đang giữ để thanh toán). Nếu ghế đang
        // AVAILABLE — kể cả khi hold của chính đơn này đã hết hạn và bị nhả
        // về trống (hold hết hạn do lỗi poll/tab đóng, không phải do tranh
        // ghế thật) — thì không ai khác đang giữ/mua nó cả, an toàn để nhận
        // lại cho đơn này. Chỉ so khớp holdId là chưa đủ: sau khi hold hết
        // hạn, seat.holdId luôn bị set về null dù chưa có ai lấy mất, so
        // holdId thẳng sẽ báo xung đột giả (đã xảy ra thật, khách "AN" bị
        // báo xung đột dù không hề có ai giữ/mua ghế đó ngoài họ).
        // ==========================================

        const validSeats = [];
        const conflictSeats = [];

        order.seatIds.forEach((seatId, i) => {

            const seatDoc = seatDocs[i];

            // Ghế không còn tồn tại (bị xoá/đổi mã giữa chừng) — trước đây bỏ
            // qua âm thầm: khách trả đủ tiền nhưng nhận thiếu vé, không ai biết.
            // Giờ đưa vào xung đột để có vé "cần xử lý" + mail cảnh báo.
            if (!seatDoc.exists) {
                conflictSeats.push({ seatId, seatStatus: "MISSING", seatData: null });
                return;
            }

            const seatData = seatDoc.data();

            const isConflict =
                seatData.status === "SOLD" ||
                (seatData.status === "HELD" && seatData.holdId !== order.holdId);

            if (isConflict) {
                conflictSeats.push({ seatId, seatStatus: seatData.status, seatData });
            } else {
                validSeats.push({ seatId, seatRef: seatRefs[i], seatData });
            }
        });

        // ==========================================
        // 3. Order → PAID (tiền đã nhận thật nên luôn phải chốt PAID, kể cả
        // khi có ghế xung đột — không thể coi như chưa nhận tiền được).
        // ==========================================

        transaction.update(orderRef, {
            orderStatus: "PAID",
            paymentStatus: "PAID",
            paidAt: now,
            updatedAt: now,
            ...(conflictSeats.length > 0
                ? { seatConflicts: conflictSeats.map((c) => ({ seatId: c.seatId, seatStatus: c.seatStatus })) }
                : {})
        });

        // ==========================================
        // 4. Hold → COMPLETED
        // ==========================================

        if (holdSnap.exists) {
            transaction.update(holdRef, {
                status: "COMPLETED",
                updatedAt: now
            });
        }

        // ==========================================
        // 5. Ghế hợp lệ → SOLD, tạo vé "valid". Ghế xung đột → KHÔNG đụng vào
        // ghế (đang thuộc về người khác), chỉ tạo vé đánh dấu
        // "conflict_needs_review" để có dấu vết đối soát/hoàn tiền tay — nhân
        // viên xử lý qua sendSeatConflictAlertEmail bên dưới, không tự động.
        // ==========================================

        const ticketsForEmail = [];

        validSeats.forEach(({ seatId, seatRef, seatData }) => {

            const ticketCode = `LS-${order.orderCode}-${seatId}`;

            transaction.update(seatRef, {
                status: "SOLD",
                holdId: null,
                holdExpiresAt: null,
                updatedAt: now
            });

            transaction.set(db.collection("tickets").doc(), {
                orderId: orderRef.id,

                showId: order.showId,
                showtimeId: order.showtimeId,
                seatId,

                customerName: order.customerName,
                customerPhone: order.customerPhone,
                customerEmail: order.customerEmail,

                price: seatData.price,

                paymentStatus: "paid",
                ticketStatus: "valid",
                ticketCode,

                checkedIn: false,
                checkedInAt: null,

                createdAt: now
            });

            ticketsForEmail.push({
                seatId,
                tierName: seatData.tierName,
                price: seatData.price,
                ticketCode
            });
        });

        conflictSeats.forEach(({ seatId, seatData }) => {

            transaction.set(db.collection("tickets").doc(), {
                orderId: orderRef.id,

                showId: order.showId,
                showtimeId: order.showtimeId,
                seatId,

                customerName: order.customerName,
                customerPhone: order.customerPhone,
                customerEmail: order.customerEmail,

                price: seatData ? seatData.price : null,

                paymentStatus: "paid",
                ticketStatus: "conflict_needs_review",
                ticketCode: `LS-${order.orderCode}-${seatId}`,

                checkedIn: false,
                checkedInAt: null,

                createdAt: now
            });
        });

        emailPayload = {
            order: {
                customerName: order.customerName,
                customerPhone: order.customerPhone,
                customerEmail: order.customerEmail,
                orderCode: order.orderCode,
                amount: order.amount,
                showId: order.showId,
                showtimeId: order.showtimeId
            },
            tickets: ticketsForEmail
        };

        if (conflictSeats.length > 0) {
            conflictPayload = {
                order: emailPayload.order,
                conflictSeats: conflictSeats.map((c) => ({ seatId: c.seatId, seatStatus: c.seatStatus }))
            };
        }
    });

    // Đơn trả thiếu tiền — gửi cảnh báo kỹ thuật để xử lý tay, không cấp vé.
    if (underpaidPayload) {
        sendSeatConflictAlertEmail(
            underpaidPayload.order,
            [{ seatId: `TRẢ THIẾU TIỀN: nhận ${underpaidPayload.paidAmount}đ / cần ${underpaidPayload.order.amount}đ`, seatStatus: "UNDERPAID" }]
        ).catch((error) => {
            console.error("GỬI MAIL CẢNH BÁO TRẢ THIẾU TIỀN THẤT BẠI:", error);
        });
    }

    // Gửi mail sau khi transaction đã chốt xong — không gửi trong lúc transaction
    // đang chạy vì Firestore có thể tự retry transaction nếu xung đột ghi.
    if (!alreadyPaid && emailPayload) {

        // Ghế xung đột hết 100% (hiếm, chỉ xảy ra khi đơn 1 ghế) thì không còn
        // vé "valid" nào để gửi — bỏ qua mail vé/thông báo đơn bình thường,
        // chỉ gửi cảnh báo xung đột bên dưới.
        if (emailPayload.tickets.length > 0) {
            // Đánh dấu emailSent để biết đơn nào đã gửi được mail vé (H6): nếu
            // gửi lỗi, ghi emailError để sau này dò và gửi lại, không mất dấu.
            sendTicketEmail(emailPayload.order, emailPayload.tickets)
                .then(() => orderRef.update({ emailSent: true, emailSentAt: new Date() }))
                .catch((error) => {
                    console.error("GỬI MAIL VÉ THẤT BẠI:", error);
                    orderRef.update({ emailSent: false, emailError: String(error && error.message || error) }).catch(() => {});
                });
            sendOrderNotificationEmail(emailPayload.order, emailPayload.tickets).catch((error) => {
                console.error("GỬI MAIL THÔNG BÁO ĐƠN THẤT BẠI:", error);
            });
        }

        if (conflictPayload) {
            sendSeatConflictAlertEmail(conflictPayload.order, conflictPayload.conflictSeats).catch((error) => {
                console.error("GỬI MAIL CẢNH BÁO XUNG ĐỘT GHẾ THẤT BẠI:", error);
            });
        }
    }

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

    // Truyền số tiền thực nhận (webhookData.amount) để đối chiếu với order.amount
    // — chặn trả thiếu tiền mà vẫn được cấp vé.
    const alreadyPaid = await finalizeOrderAsPaid(orderRef, webhookData.amount);

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
        // amountPaid: số tiền PayOS xác nhận đã nhận — đối chiếu với order.amount.
        await finalizeOrderAsPaid(orderRef, paymentLink.amountPaid);
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
