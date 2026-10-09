const crypto = require("crypto");
const { db } = require("../config/firebase");
const { FieldPath } = require("firebase-admin/firestore");
const BOOKING_CONFIG = require("../config/booking.config");
const { sendTicketEmail } = require("./email.service");
const SEAT_TIERS = require("../../scripts/seatTiers.json");
const LOCKED_ZONE_SEATS = new Set(require("../../scripts/lockedZoneSeats.json").seatIds);
const { appendGateScanRow } = require("./googleSheets.service");

const DOW_NAMES = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];

// ==========================================
// KHU GHẾ "KHÔNG ĐƯỢC THẦU BÁN" (toàn bộ lẻ + range chẵn, 13 hàng — xem
// CLAUDE.md mục "Khóa 1 phần ghế") — một số ghế trong khu này đã LỠ bán được
// trước khi khu bị khoá (vd khách mua sớm từ tháng 9). Khi đơn đó sau này bị
// huỷ/xoá/đổi ghế, ghế phải quay lại BLOCKED (đúng ý nghĩa gốc: không phải
// hàng để bán) chứ KHÔNG được thả về AVAILABLE — nếu không nó sẽ "sáng lên"
// (bán được) giữa khu đã khoá, đúng lỗi phát hiện thực tế ở ghế B21/B17/B19
// suất 2026-10-04_16:30 sau khi đổi vé cho khách Võ Thị Minh Nguyệt
// (2026-10-03). Dùng hàm này ở MỌI chỗ "trả ghế lại" (huỷ vé theo ghế, xoá
// đơn, đổi vé) thay vì set cứng "AVAILABLE".
// ==========================================

function releaseStatusFor(seatId) {
    return LOCKED_ZONE_SEATS.has(seatId) ? "BLOCKED" : "AVAILABLE";
}

const RELEASE_BLOCK_NOTE = "Khoá lại tự động — ghế thuộc khu không-được-thầu-bán, " +
    "trả về sau khi huỷ/xoá/đổi đơn (xem releaseStatusFor() trong admin.service.js)";

// Chỉ cho phép mã ghế dạng {hàng}{số}: 1-2 chữ cái hoa + 1-3 số (vd B12, AB9),
// hoặc mã khu VIP dạng VIP{số} (VIP1-VIP43, xem VIP_SEAT_XY ở frontend/dat-ve.html).
// Chặn chuỗi độc hại (path injection kiểu "../..") lọt vào đường dẫn Firestore.
const SEAT_ID_RE = /^([A-Z]{1,2}\d{1,3}|VIP\d{1,2})$/;

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
            const releaseStatus = releaseStatusFor(seatId);
            transaction.update(seatRef, {
                status: releaseStatus,
                blockNote: releaseStatus === "BLOCKED" ? RELEASE_BLOCK_NOTE : null,
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
// HUỶ MỘT PHẦN GHẾ CỦA ĐƠN ĐÃ THANH TOÁN — khách trả lại vài ghế trong 1 đơn
// nhiều ghế (giữ phần còn lại), khác cancelTicketBySeat() (huỷ 1 vé lẻ,
// không đụng order) và deleteOrder() (xoá nguyên cả đơn). Tự tính lại
// amount/subtotal/seatIds trên order cho khớp đúng các ghế còn lại — PHẢI
// cập nhật seatIds, không chỉ amount, vì exchangePaidOrderTickets() dựa vào
// order.seatIds.length để khớp số vé hợp lệ (xem sự cố thật 2026-10-06, đơn
// Youngim Jung: sửa tay amount qua script tmp_ mà quên seatIds làm hỏng
// tính năng đổi vé của đơn vĩnh viễn — đây là lý do hàm này được viết thành
// tool thay vì lặp lại script tạm mỗi lần).
// ==========================================

async function cancelOrderSeats({ showId, orderId, seatIdsToCancel }) {

    if (!orderId || !Array.isArray(seatIdsToCancel) || seatIdsToCancel.length === 0) {
        throw new Error("Thiếu orderId/seatIdsToCancel");
    }

    const uniqueSeatIds = [...new Set(seatIdsToCancel)];
    if (uniqueSeatIds.length !== seatIdsToCancel.length) {
        throw new Error("Danh sách ghế huỷ bị trùng");
    }
    if (uniqueSeatIds.some((seatId) => !SEAT_ID_RE.test(seatId))) {
        throw new Error("Mã ghế không hợp lệ");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const now = new Date();

    return db.runTransaction(async (transaction) => {

        // ---- Đọc hết trước, Firestore transaction không cho đọc sau khi đã ghi ----

        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists) {
            throw new Error("Không tìm thấy đơn hàng");
        }

        const order = orderSnap.data();
        if (order.showId && order.showId !== showId) {
            throw new Error("Đơn hàng không thuộc show này");
        }
        if (order.orderStatus !== "PAID" || order.paymentStatus !== "PAID") {
            throw new Error("Chỉ huỷ ghế từng phần cho đơn đã thanh toán");
        }

        const showtimeId = order.showtimeId;
        if (!showtimeId) {
            throw new Error("Đơn hàng không có suất diễn");
        }
        if (!Array.isArray(order.seatIds) || !uniqueSeatIds.every((s) => order.seatIds.includes(s))) {
            throw new Error("Có ghế không thuộc đơn hàng này");
        }

        const ticketsSnap = await transaction.get(
            db.collection("tickets")
                .where("orderId", "==", orderId)
                .where("ticketStatus", "==", "valid")
        );
        if (ticketsSnap.empty) {
            throw new Error("Đơn hàng không còn vé hợp lệ nào");
        }

        const validTicketDocs = ticketsSnap.docs;
        const ticketBySeat = new Map(validTicketDocs.map((doc) => [doc.data().seatId, doc]));

        const missingSeat = uniqueSeatIds.find((seatId) => !ticketBySeat.has(seatId));
        if (missingSeat) {
            throw new Error(`Ghế ${missingSeat} không có vé hợp lệ trong đơn (có thể đã huỷ trước đó)`);
        }

        const ticketsToCancel = uniqueSeatIds.map((seatId) => ticketBySeat.get(seatId));

        const checkedInTicket = ticketsToCancel.find((doc) => doc.data().checkedIn === true);
        if (checkedInTicket) {
            throw new Error(`Ghế ${checkedInTicket.data().seatId} đã check-in, không thể huỷ`);
        }

        if (validTicketDocs.length - ticketsToCancel.length <= 0) {
            throw new Error('Không thể huỷ hết toàn bộ ghế qua công cụ này — dùng "Xoá đơn" để huỷ cả đơn');
        }

        const seatRefs = uniqueSeatIds.map((seatId) => db.collection("shows").doc(showId)
            .collection("showtimes").doc(showtimeId).collection("seats").doc(seatId));
        const seatSnaps = await Promise.all(seatRefs.map((ref) => transaction.get(ref)));

        // ---- Hết phần đọc, từ đây chỉ ghi ----

        const remainingSeatIds = [];
        let newSubtotal = 0;
        validTicketDocs.forEach((doc) => {
            const data = doc.data();
            if (!uniqueSeatIds.includes(data.seatId)) {
                remainingSeatIds.push(data.seatId);
                newSubtotal += data.price || 0;
            }
        });

        // ticket.price là giá ghế gốc (chưa trừ coupon, xem payment.service.js) nên
        // amount mới phải tự áp lại % coupon cũ (nếu có) trên subtotal mới, không
        // thể suy ra bằng cách trừ thẳng giá ghế đã huỷ khỏi amount cũ.
        let newAmount = newSubtotal;
        if (order.coupon && order.coupon.percentOff) {
            const discount = Math.round(newSubtotal * order.coupon.percentOff / 100);
            newAmount = newSubtotal - discount;
        }

        ticketsToCancel.forEach((ticketDoc) => {
            transaction.update(ticketDoc.ref, {
                ticketStatus: "cancelled",
                cancelledAt: now,
                cancelledBy: "admin-panel"
            });
        });

        uniqueSeatIds.forEach((seatId, i) => {
            const seatSnap = seatSnaps[i];
            if (seatSnap.exists) {
                const releaseStatus = releaseStatusFor(seatId);
                transaction.update(seatSnap.ref, {
                    status: releaseStatus,
                    blockNote: releaseStatus === "BLOCKED" ? RELEASE_BLOCK_NOTE : null,
                    holdId: null,
                    holdExpiresAt: null,
                    updatedAt: now
                });
            }
        });

        transaction.update(orderRef, {
            seatIds: remainingSeatIds,
            subtotal: newSubtotal,
            amount: newAmount,
            updatedAt: now
        });

        return {
            cancelledSeats: uniqueSeatIds,
            remainingSeats: remainingSeatIds,
            newAmount,
            newSubtotal
        };
    });
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
// KHÓA RIÊNG CHO APP SOÁT VÉ (gate) — tách khỏi ADMIN_PIN vì app quét liên
// tục ở màn hình chính, không đi qua màn hình nhập PIN như AdminPanelController
// (huỷ/tạo vé). Không có fallback mặc định như ADMIN_PIN: thiếu env thì
// fail-closed, giống PARTNER_API_KEY.
// ==========================================

const GATE_API_KEY = process.env.GATE_API_KEY || "";

function checkGateKey(key) {
    if (!GATE_API_KEY) return false;
    if (typeof key !== "string") return false;
    const a = Buffer.from(key);
    const b = Buffer.from(GATE_API_KEY);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ==========================================
// CHECK-IN VÉ TẠI CỔNG — thay thế hoàn toàn việc app Unity đọc/ghi Firestore
// "tickets" trực tiếp qua Firebase Client SDK (lỗ hổng C1/C7 trong CLAUDE.md:
// client tự do đọc PII mọi vé, và logic cũ chỉ kiểm checkedIn chứ không kiểm
// ticketStatus/đúng suất đang diễn — vé đã huỷ hoặc đang "conflict_needs_review"
// vẫn lọt qua được). Transaction này là nguồn sự thật DUY NHẤT quyết định 1 vé
// có được vào cổng hay không.
//
// Dùng chung classifyTicketForGate() với lookupTicketByCode() (tra cứu
// read-only, không check-in — màn hình "hiện thông tin vé" trước khi nhân
// viên bấm nút CHECK-IN) để 2 nơi không bao giờ lệch logic nhận định vé.
// ==========================================

// Tính theo giờ Việt Nam RÕ RÀNG, không dựa vào timezone mặc định của
// container chạy server (Render — thường là UTC). Showtime/lịch diễn đều
// theo giờ VN, lệch timezone sẽ khiến khoảng 00:00-06:59 giờ VN server vẫn
// tính nhầm là "hôm qua" theo UTC, từ chối nhầm vé của đúng suất hôm nay.
function todayDateKey() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

function classifyTicketForGate(ticket, todayKey) {
    if (!ticket) return "NOT_FOUND";
    if (ticket.ticketStatus === "cancelled") return "CANCELLED";
    if (ticket.ticketStatus === "conflict_needs_review") return "CONFLICT";
    if (ticket.ticketStatus !== "valid") return "INVALID_STATUS";
    if ((ticket.showtimeId || "").split("_")[0] !== todayKey) return "WRONG_DATE";
    if (ticket.checkedIn === true) return "ALREADY_CHECKED_IN";
    return "READY";
}

const GATE_MESSAGES = {
    NOT_FOUND: "Vé không tồn tại",
    CANCELLED: "Vé đã bị huỷ, không hợp lệ",
    CONFLICT: "Vé đang chờ xử lý xung đột, liên hệ admin",
    INVALID_STATUS: "Vé không hợp lệ",
    WRONG_DATE: "Vé không phải của suất diễn hôm nay",
    ALREADY_CHECKED_IN: "Vé đã được check-in trước đó",
    READY: "Sẵn sàng check-in",
    OK: "Hợp lệ"
};

// Tra cứu READ-ONLY — màn hình "hiện thông tin vé" sau khi quét, TRƯỚC khi
// nhân viên đối chiếu khách rồi tự bấm nút CHECK-IN (xem checkInTicketByCode
// bên dưới cho bước mutate thật). Không transaction vì không ghi gì.
async function lookupTicketByCode({ ticketCode }) {

    if (!ticketCode || typeof ticketCode !== "string") {
        throw new Error("Thiếu ticketCode");
    }

    const snap = await db.collection("tickets")
        .where("ticketCode", "==", ticketCode)
        .limit(1)
        .get();

    const ticket = snap.empty ? null : snap.docs[0].data();
    const outcomeCode = classifyTicketForGate(ticket, todayDateKey());

    return {
        outcome: outcomeCode,
        ready: outcomeCode === "READY",
        message: GATE_MESSAGES[outcomeCode],
        ticketCode,
        seatId: ticket ? (ticket.seatId || null) : null,
        customerName: ticket ? (ticket.customerName || "") : "",
        showtimeId: ticket ? (ticket.showtimeId || null) : null,
        tierName: ticket ? (ticket.tierName || null) : null,
        price: ticket ? (ticket.price != null ? ticket.price : null) : null
    };
}

// Transaction check-in CHO 1 DOC vé — tách riêng để checkInTicketByCode()
// (1 vé) và checkInOrderByTicketCode() (cả đơn, xem bên dưới) dùng chung,
// không lặp lại logic transaction. dryRun=true (gate-scanner.html tick
// "TestScan"): vẫn đọc + chấm outcome y hệt thật, NHƯNG bỏ qua bước ghi
// checkedIn — để tester quét lại ĐÚNG 1 mã nhiều lần (luôn ra lại "READY")
// mà không cần tạo mã mới mỗi lần, không đụng dữ liệu Firestore thật.
async function checkInTicketDoc(ticketRef, todayKey, dryRun) {

    const now = new Date();

    return db.runTransaction(async (transaction) => {

        const ticketSnap = await transaction.get(ticketRef);

        if (!ticketSnap.exists) {
            return { code: "NOT_FOUND" };
        }

        const ticket = ticketSnap.data();
        const code = classifyTicketForGate(ticket, todayKey);

        if (code !== "READY") {
            return { code, ticket };
        }

        if (!dryRun) {
            transaction.update(ticketRef, {
                checkedIn: true,
                checkedInAt: now
            });
        }

        return { code: "OK", ticket };
    });
}

async function checkInTicketByCode({ ticketCode, dryRun }) {

    if (!ticketCode || typeof ticketCode !== "string") {
        throw new Error("Thiếu ticketCode");
    }

    const snap = await db.collection("tickets")
        .where("ticketCode", "==", ticketCode)
        .limit(1)
        .get();

    if (snap.empty) {
        return {
            outcome: "NOT_FOUND",
            success: false,
            alreadyCheckedIn: false,
            message: GATE_MESSAGES.NOT_FOUND
        };
    }

    const outcome = await checkInTicketDoc(snap.docs[0].ref, todayDateKey(), dryRun);
    const ticket = outcome.ticket || {};

    return {
        outcome: outcome.code,
        success: outcome.code === "OK",
        alreadyCheckedIn: outcome.code === "ALREADY_CHECKED_IN",
        message: outcome.code === "OK"
            ? `Hợp lệ - ${ticket.customerName || ""}`
            : GATE_MESSAGES[outcome.code],
        ticketCode,
        seatId: ticket.seatId || null,
        customerName: ticket.customerName || "",
        showtimeId: ticket.showtimeId || null
    };
}

// ==========================================
// CHECK-IN CẢ ĐƠN QUA 1 LẦN QUÉT — khách mua nhiều ghế trong 1 đơn thường
// vào cổng cùng lúc; quét lần lượt từng vé (từng mã QR riêng) rất chậm nếu
// đơn có nhiều ghế. Quét ĐÚNG 1 mã vé bất kỳ trong đơn, tự tìm toàn bộ vé
// cùng orderId rồi check-in hết trong 1 lượt (mỗi vé vẫn transaction riêng,
// giống checkInTicketByCode — 1 vé lỗi/đã check-in không chặn các vé còn
// lại của đơn). Gate-scanner.html gọi endpoint này khi tick "check-in cả
// đơn"; bỏ tick thì vẫn gọi checkInTicketByCode (1 vé) như cũ.
// ==========================================
async function checkInOrderByTicketCode({ ticketCode, dryRun }) {

    if (!ticketCode || typeof ticketCode !== "string") {
        throw new Error("Thiếu ticketCode");
    }

    const snap = await db.collection("tickets")
        .where("ticketCode", "==", ticketCode)
        .limit(1)
        .get();

    if (snap.empty) {
        return {
            outcome: "NOT_FOUND",
            customerName: "",
            showtimeId: null,
            totalInOrder: 0,
            checkedInCount: 0,
            tickets: []
        };
    }

    const scannedTicket = snap.docs[0].data();
    const orderId = scannedTicket.orderId || null;
    const todayKey = todayDateKey();

    // Vé cũ lý thuyết có thể thiếu orderId (không nên xảy ra với dữ liệu hiện
    // tại) — fail-safe về lại đúng 1 vé vừa quét thay vì quét where("orderId"
    // ,"==",null) trả nhầm các vé khác cũng thiếu orderId.
    const orderDocs = orderId
        ? (await db.collection("tickets").where("orderId", "==", orderId).get()).docs
        : [snap.docs[0]];

    const tickets = [];

    for (const doc of orderDocs) {
        const outcome = await checkInTicketDoc(doc.ref, todayKey, dryRun);
        const t = outcome.ticket || {};
        tickets.push({
            ticketCode: t.ticketCode || doc.id,
            seatId: t.seatId || null,
            success: outcome.code === "OK",
            alreadyCheckedIn: outcome.code === "ALREADY_CHECKED_IN",
            message: GATE_MESSAGES[outcome.code] || GATE_MESSAGES.OK
        });
    }

    return {
        outcome: "ORDER_PROCESSED",
        orderId,
        customerName: scannedTicket.customerName || "",
        showtimeId: scannedTicket.showtimeId || null,
        totalInOrder: tickets.length,
        checkedInCount: tickets.filter((t) => t.success).length,
        tickets
    };
}

// ==========================================
// LỊCH SỬ QUÉT VÉ TẠI CỔNG (gate-scanner.html) — ghi lại MỌI lượt quét (kể
// cả không ready/lỗi, và cả lượt TestScan dryRun, đánh dấu testMode riêng)
// để xem lại khi cần đối chiếu/troubleshoot, KHÔNG phải audit log thao tác
// admin (khác mục đích với adminActivityLog — path /admin/tickets/* vẫn
// nằm trong SKIP_LOG_PATHS của log đó vì tần suất quá cao). Ghi
// fire-and-forget (route gọi không await) để không làm chậm response check-in.
//
// Giữ tối đa 100 bản ghi gần nhất — xoá phần dư ngay sau mỗi lần ghi thay vì
// để phình vô hạn suốt mùa diễn (quét liên tục mỗi suất).
// ==========================================

const GATE_SCAN_HISTORY_LIMIT = 100;

async function logGateScan({ ticketCode, customerName, seats, showtimeId, outcome, checkedInCount, totalCount, message, testMode }) {

    const scannedAt = new Date();

    await db.collection("gateScanHistory").add({
        ticketCode: ticketCode || null,
        customerName: customerName || "",
        seats: seats || [],
        showtimeId: showtimeId || null,
        outcome: outcome || null,
        checkedInCount: checkedInCount || 0,
        totalCount: totalCount || 0,
        message: message || "",
        testMode: !!testMode,
        scannedAt
    });

    // Đẩy lên Google Sheet cho venue xem real-time — không đẩy vé test, và lỗi ở
    // đây KHÔNG BAO GIỜ được làm hỏng việc quét vé thật ở cổng (chỉ log lỗi).
    if (!testMode) {
        appendGateScanRow({
            scannedAt, ticketCode, customerName, seats, showtimeId,
            outcome, checkedInCount, totalCount, message
        }).catch((err) => console.error("GOOGLE SHEET GATE SCAN LOG ERROR:", err.message));
    }

    const overflow = await db.collection("gateScanHistory")
        .orderBy("scannedAt", "desc")
        .offset(GATE_SCAN_HISTORY_LIMIT)
        .get();

    if (!overflow.empty) {
        const batch = db.batch();
        overflow.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
    }
}

async function listGateScanHistory() {

    const snap = await db.collection("gateScanHistory")
        .orderBy("scannedAt", "desc")
        .limit(GATE_SCAN_HISTORY_LIMIT)
        .get();

    return snap.docs.map((doc) => {
        const d = doc.data();
        return {
            id: doc.id,
            ticketCode: d.ticketCode || null,
            customerName: d.customerName || "",
            seats: d.seats || [],
            showtimeId: d.showtimeId || null,
            outcome: d.outcome || null,
            checkedInCount: d.checkedInCount || 0,
            totalCount: d.totalCount || 0,
            message: d.message || "",
            testMode: !!d.testMode,
            scannedAt: d.scannedAt ? d.scannedAt.toDate().toISOString() : null
        };
    });
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

    const todayKey = todayDateKey();

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
            const releaseStatus = releaseStatusFor(seatId);
            batch.update(seatsRef.doc(seatId), {
                status: releaseStatus,
                blockNote: releaseStatus === "BLOCKED" ? RELEASE_BLOCK_NOTE : null,
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

        sourceSeatRefs.forEach((ref, i) => {
            const releaseStatus = releaseStatusFor(fromSeatIds[i]);
            transaction.update(ref, {
                status: releaseStatus,
                blockNote: releaseStatus === "BLOCKED" ? RELEASE_BLOCK_NOTE : null,
                holdId: null,
                holdExpiresAt: null,
                updatedAt: now
            });
        });

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

// ==========================================
// TRANG "QUẢN LÝ SUẤT DIỄN" (admin-showtimes.html) — thay thế quy trình
// script tmp_*.js thủ công để thêm/xoá/khoá suất diễn và sửa sơ đồ ghế.
// Không có collection "ngày diễn" riêng — lịch được tính (derive) trực tiếp
// từ các doc showtimes hiện có, nhóm theo phần ngày của showtimeId.
// ==========================================

const SHOWTIME_ID_RE = /^\d{4}-\d{2}-\d{2}_\d{2}:\d{2}$/;

const TIER_PRICES = {
    "son-than": { name: "Sơn Thần", price: 300000 },
    "thuy-quai": { name: "Thủy Quái", price: 250000 },
    "mi-nuong": { name: "Mị Nương", price: 200000 },
    "vua-hung": { name: "Vua Hùng", price: 400000 }
};

// G1-G58 dành riêng cho staff/lãnh đạo — mặc định SOLD ngay từ lúc seed, y
// hệt quy ước trong seedSeats.js, để suất diễn thêm qua trang admin cũng tự
// chặn đúng những ghế này ngay từ đầu.
const STAFF_ROW = "G";
const STAFF_SEAT_MAX = 58;

// Seed "sạch" từ seatTiers.json — mọi ghế AVAILABLE (trừ staff-seat) — KHÔNG
// copy trạng thái từ suất khác. Đây chính là điểm sửa cho lỗi 20-ghế-SOLD-ảo
// từng xảy ra khi thêm suất 2026-10-04_10:00 bằng script tạm copy nguyên
// trạng thái từ suất tham chiếu (xem CLAUDE.md/lịch sử phiên làm việc).
function buildFreshSeatDocs() {
    return Object.keys(SEAT_TIERS).map((seatCode) => {
        const [, row, numberStr] = seatCode.match(/^([A-Z]+)(\d+)$/);
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
            status: (row === STAFF_ROW && number <= STAFF_SEAT_MAX) ? "SOLD" : "AVAILABLE",
            holdId: null,
            holdExpiresAt: null
        };
    });
}

// ==========================================
// LỊCH SUẤT DIỄN THEO THÁNG — dùng đúng kỹ thuật orderBy(documentId()) +
// startAt/endAt như listUpcomingShowtimes() (showtimeId dạng YYYY-MM-DD_HH:MM
// nên so chuỗi = so thời gian thật). hasOrders dùng 2 filter bằng nhau
// (showId, showtimeId) nên không cần composite index mới.
// ==========================================

async function getShowtimesCalendar({ showId, year, month }) {

    const y = Number(year);
    const m = Number(month);

    if (!showId || !Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
        throw new Error("Thiếu hoặc sai year/month");
    }

    const mm = String(m).padStart(2, "0");
    const startKey = `${y}-${mm}-01`;
    const endKey = `${y}-${mm}-32`;

    const snap = await db.collection("shows").doc(showId)
        .collection("showtimes")
        .orderBy(FieldPath.documentId())
        .startAt(startKey)
        .endAt(endKey)
        .get();

    const showtimes = snap.docs.map((doc) => {
        const data = doc.data();
        return {
            showtimeId: doc.id,
            status: data.status,
            seatCount: data.seatCount || 0,
            seatsSeeded: data.seatsSeeded === true
        };
    });

    await Promise.all(showtimes.map(async (st) => {
        const ordersSnap = await db.collection("orders")
            .where("showId", "==", showId)
            .where("showtimeId", "==", st.showtimeId)
            .limit(1)
            .get();
        st.hasOrders = !ordersSnap.empty;
    }));

    return showtimes;
}

// ==========================================
// TẠO SUẤT DIỄN MỚI — seed sạch từ seatTiers.json, status mặc định "CLOSED"
// (khác seedSeats.js CLI mặc định OPEN — đây là thêm suất đơn lẻ qua UI, để
// admin tự cấu hình khoá/mở ghế xong mới bấm mở bán, tránh lộ suất chưa sẵn
// sàng cho khách như từng nhắc trong CLAUDE.md).
// ==========================================

async function createShowtime({ showId, showtimeId }) {

    if (!SHOWTIME_ID_RE.test(showtimeId)) {
        throw new Error("showtimeId không đúng định dạng YYYY-MM-DD_HH:MM");
    }

    const showtimeRef = db.collection("shows").doc(showId).collection("showtimes").doc(showtimeId);
    const existing = await showtimeRef.get();

    if (existing.exists) {
        throw new Error("Suất diễn này đã tồn tại");
    }

    const seats = buildFreshSeatDocs();
    const now = new Date();

    await showtimeRef.set({
        status: "CLOSED",
        seatsSeeded: true,
        seatCount: seats.length,
        createdAt: now,
        createdBy: "admin-panel"
    });

    const seatsCollection = showtimeRef.collection("seats");
    const BATCH_SIZE = 400;
    const writes = [];

    for (let i = 0; i < seats.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const chunk = seats.slice(i, i + BATCH_SIZE);
        chunk.forEach((seat) => {
            batch.create(seatsCollection.doc(seat.seatCode), {
                ...seat,
                createdAt: now,
                updatedAt: now
            });
        });
        writes.push(batch.commit());
    }

    await Promise.all(writes);

    return { showtimeId, seatCount: seats.length, status: "CLOSED" };
}

// ==========================================
// KHOÁ/MỞ HÀNG LOẠT SUẤT DIỄN — dùng cho cả 1 suất lẻ lẫn "khoá/mở cả ngày"
// (client tự gom danh sách showtimeId của ngày đó rồi gọi 1 lần).
// ==========================================

async function setShowtimesStatus({ showId, showtimeIds, status }) {

    if (!Array.isArray(showtimeIds) || showtimeIds.length === 0) {
        throw new Error("Thiếu danh sách suất diễn");
    }

    if (status !== "OPEN" && status !== "CLOSED") {
        throw new Error("status không hợp lệ");
    }

    const now = new Date();
    const batch = db.batch();

    showtimeIds.forEach((showtimeId) => {
        const ref = db.collection("shows").doc(showId).collection("showtimes").doc(showtimeId);
        batch.update(ref, { status, updatedAt: now });
    });

    await batch.commit();

    return { updated: showtimeIds.length, status };
}

// ==========================================
// XOÁ SUẤT DIỄN — chặn cứng nếu có đơn hàng thật (dữ liệu khách hàng, không
// được xoá âm thầm) hoặc có ghế đang HELD (khách đang giữ dở, tránh cướp hold
// đang thanh toán). Ghế SOLD do quy ước staff-seat (G1-G58, không có order
// thật đứng sau) KHÔNG chặn xoá.
// ==========================================

async function deleteShowtime({ showId, showtimeId }) {

    if (!showtimeId) {
        throw new Error("Thiếu showtimeId");
    }

    const ordersSnap = await db.collection("orders")
        .where("showId", "==", showId)
        .where("showtimeId", "==", showtimeId)
        .limit(1)
        .get();

    if (!ordersSnap.empty) {
        throw new Error("Suất diễn đã có đơn hàng thật, không thể xoá");
    }

    const showtimeRef = db.collection("shows").doc(showId).collection("showtimes").doc(showtimeId);
    const seatsCollection = showtimeRef.collection("seats");
    const seatsSnap = await seatsCollection.get();

    const heldCount = seatsSnap.docs.filter((doc) => doc.data().status === "HELD").length;
    if (heldCount > 0) {
        throw new Error(`Có ${heldCount} ghế đang được giữ, thử lại sau`);
    }

    const docs = seatsSnap.docs;
    const BATCH_SIZE = 400;
    const writes = [];

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batch = db.batch();
        docs.slice(i, i + BATCH_SIZE).forEach((doc) => batch.delete(doc.ref));
        writes.push(batch.commit());
    }

    await Promise.all(writes);
    await showtimeRef.delete();

    return { showtimeId, deletedSeats: docs.length };
}

// ==========================================
// SỬA HÀNG LOẠT TRẠNG THÁI GHẾ (mở/khoá) — dùng cho thao tác kéo-chọn nhiều
// ghế trên sơ đồ. Bỏ qua (báo lại trong "skipped") ghế đang SOLD/HELD thay vì
// ghi đè, đúng quy ước đã áp dụng xuyên suốt các script tmp_*.js trước đây.
// ==========================================

async function bulkUpdateSeats({ showId, showtimeId, seatIds, status, blockNote }) {

    if (!showtimeId || !Array.isArray(seatIds) || seatIds.length === 0) {
        throw new Error("Thiếu showtimeId/seatIds");
    }

    if (status !== "AVAILABLE" && status !== "BLOCKED") {
        throw new Error("status không hợp lệ");
    }

    if (seatIds.some((id) => !SEAT_ID_RE.test(id))) {
        throw new Error("Có mã ghế không hợp lệ");
    }

    const seatsCollection = db.collection("shows").doc(showId)
        .collection("showtimes").doc(showtimeId).collection("seats");

    const snaps = await Promise.all(seatIds.map((id) => seatsCollection.doc(id).get()));

    const updated = [];
    const skipped = [];
    const now = new Date();
    const batch = db.batch();

    snaps.forEach((snap, i) => {
        const seatId = seatIds[i];

        if (!snap.exists) {
            skipped.push({ seatId, reason: "not_found" });
            return;
        }

        const current = snap.data().status;
        if (current === "SOLD" || current === "HELD") {
            skipped.push({ seatId, reason: current });
            return;
        }

        batch.update(snap.ref, {
            status,
            blockNote: status === "BLOCKED" ? (blockNote || "Khoá thủ công qua trang quản trị") : null,
            updatedAt: now
        });
        updated.push(seatId);
    });

    if (updated.length > 0) {
        await batch.commit();
    }

    return { updated, skipped };
}

// ==========================================
// ĐỔI MÃ GHẾ — chỉ cho ghế AVAILABLE/BLOCKED (không phải SOLD/HELD), dùng khi
// phát hiện sai mã lúc thêm suất mới. Transaction để tránh vừa tạo mã mới vừa
// còn sót mã cũ nếu có lỗi giữa chừng.
// ==========================================

async function renameSeat({ showId, showtimeId, oldSeatId, newSeatId }) {

    if (!SEAT_ID_RE.test(oldSeatId) || !SEAT_ID_RE.test(newSeatId)) {
        throw new Error("Mã ghế không hợp lệ");
    }

    if (oldSeatId === newSeatId) {
        throw new Error("Mã ghế mới trùng mã cũ");
    }

    const seatsCollection = db.collection("shows").doc(showId)
        .collection("showtimes").doc(showtimeId).collection("seats");
    const oldRef = seatsCollection.doc(oldSeatId);
    const newRef = seatsCollection.doc(newSeatId);
    const m = newSeatId.match(/^([A-Z]+)(\d+)$/);

    await db.runTransaction(async (transaction) => {

        const [oldSnap, newSnap] = await Promise.all([
            transaction.get(oldRef),
            transaction.get(newRef)
        ]);

        if (!oldSnap.exists) {
            throw new Error(`Ghế ${oldSeatId} không tồn tại`);
        }

        if (newSnap.exists) {
            throw new Error(`Ghế ${newSeatId} đã tồn tại`);
        }

        const data = oldSnap.data();

        if (data.status === "SOLD" || data.status === "HELD") {
            throw new Error("Không thể đổi mã ghế đã bán hoặc đang được giữ");
        }

        const number = parseInt(m[2], 10);

        transaction.set(newRef, {
            ...data,
            seatCode: newSeatId,
            row: m[1],
            number,
            side: number % 2 === 1 ? "odd" : "even",
            updatedAt: new Date()
        });
        transaction.delete(oldRef);
    });

    return { oldSeatId, newSeatId };
}

module.exports = {
    checkPin,
    checkGateKey,
    lookupTicketByCode,
    checkInTicketByCode,
    checkInOrderByTicketCode,
    logGateScan,
    listGateScanHistory,
    cancelTicketBySeat,
    cancelOrderSeats,
    createManualTicket,
    exchangePaidOrderTickets,
    listUpcomingShowtimes,
    deleteOrder,
    updateOrderCustomerInfo,
    findOrderByCode,
    resendOrderTicketEmail,
    getShowtimesCalendar,
    createShowtime,
    setShowtimesStatus,
    deleteShowtime,
    bulkUpdateSeats,
    renameSeat
};
