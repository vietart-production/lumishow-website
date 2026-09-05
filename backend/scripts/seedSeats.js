const { db } = require("../src/config/firebase");
const { FieldValue } = require("firebase-admin/firestore");
const SEAT_TIERS = require("./seatTiers.json");


// ==========================================
// CẤU HÌNH SHOW / SUẤT DIỄN
// ==========================================

const SHOW_ID = "son-than-thuy-quai";

const SEASON_START = new Date(2026, 8, 25);
const SEASON_END = new Date(2026, 11, 27);
const SHOWTIMES_BY_DAY = {
    0: ["10:00", "16:30"],
    5: ["20:00"],
    6: ["16:30", "20:00"]
};


// ==========================================
// HẠNG GHẾ
// Lấy theo BookingTicket.html
// ==========================================

const TIERS = {
    "son-than": {
        name: "Sơn Thần",
        price: 300000
    },

    "thuy-quai": {
        name: "Thủy Quái",
        price: 250000
    },

    "mi-nuong": {
        name: "Mị Nương",
        price: 200000
    }
};


// ==========================================
// HẠNG GHẾ THEO TỪNG GHẾ THẬT
// ------------------------------------------
// seatTiers.json là danh sách 1181 ghế thật + hạng của từng ghế, tự sinh
// từ toạ độ thật trong frontend/BookingTicket.html (SEAT_XY), theo quy tắc:
//   - Phía trước (đối diện sân khấu, y > CY): hàng B,C,D,E,G,H,I = "son-than"
//     (300k), hàng K,L,M,N,O,P = "thuy-quai" (250k).
//   - Phía sau (mọi hàng) = "mi-nuong" (200k).
// Dùng đúng 1181 ghế thật này thay vì tính theo tổng số ghế/hàng, để tránh
// lệch với sơ đồ ghế thật bên frontend (trước đây sinh dư 105 ghế ảo).
// Muốn tái tạo lại file này: xem seatTiers.generate.js.
// ==========================================

const SEAT_CODE_RE = /^([A-Z]+)(\d+)$/;

function buildSeats() {
    const seats = [];

    for (const seatCode of Object.keys(SEAT_TIERS)) {

        const [, row, numberStr] = seatCode.match(SEAT_CODE_RE);
        const number = parseInt(numberStr, 10);

        const tier = SEAT_TIERS[seatCode];
        const price = TIERS[tier].price;

        seats.push({
            seatCode,
            row,
            number,

            side: number % 2 === 1
                ? "odd"
                : "even",

            tier,
            tierName: TIERS[tier].name,

            price,

            status: "AVAILABLE",

            holdId: null,
            holdExpiresAt: null
        });
    }

    return seats;
}

function buildShowtimeIds() {
    const showtimeIds = [];

    for (const date = new Date(SEASON_START); date <= SEASON_END; date.setDate(date.getDate() + 1)) {
        const times = SHOWTIMES_BY_DAY[date.getDay()] || [];
        const dateKey = [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, "0"),
            String(date.getDate()).padStart(2, "0")
        ].join("-");

        for (const time of times) {
            showtimeIds.push(`${dateKey}_${time}`);
        }
    }

    return showtimeIds;
}


// ==========================================
// ĐẨY GHẾ LÊN FIRESTORE
// ==========================================

async function seedShowAndShowtime(showtimeId) {

    const showRef = db.collection("shows").doc(SHOW_ID);

    await showRef.set({
        name: "Sơn Thần Thủy Quái",
        status: "active"
    }, { merge: true });


    const showtimeRef = showRef
        .collection("showtimes")
        .doc(showtimeId);

    // Đọc trước để biết showtime đã tồn tại chưa — CHỈ set status "OPEN" khi
    // tạo mới. Nếu showtime đã có sẵn (kể cả từng bị đổi sang trạng thái khác
    // bởi 1 tính năng admin nào đó sau này, ví dụ đóng suất/huỷ suất), chạy
    // lại script sẽ không âm thầm ép nó về "OPEN" nữa.
    const showtimeSnap = await showtimeRef.get();

    if (!showtimeSnap.exists) {
        await showtimeRef.set({ status: "OPEN" });
        console.log(`Đã tạo showtime "${showtimeId}" (status OPEN).`);
    } else {
        console.log(`Showtime "${showtimeId}" đã tồn tại, giữ nguyên status hiện tại.`);
    }

    return { showtimeRef, showtimeSnap };
}


async function seedSeatsForShowtime(showtimeRef, showtimeSnap, showtimeId, seats) {

    // Cờ seatsSeeded đánh dấu suất này đã seed đủ ghế — bỏ qua ngay từ dữ liệu
    // đã đọc sẵn ở seedShowAndShowtime, khỏi phải đọc lại toàn bộ collection
    // seats (1181 doc) mỗi lần chạy lại script, ví dụ khi chỉ thêm suất diễn
    // mới ở cuối mùa.
    const showtimeData = showtimeSnap.data() || {};

    if (showtimeData.seatsSeeded === true && showtimeData.seatCount === seats.length) {
        console.log(`Suất ${showtimeId}: đã seed đủ ${seats.length} ghế từ trước, bỏ qua.`);
        return;
    }

    const seatsCollection = showtimeRef.collection("seats");

    // Chỉ tạo ghế còn thiếu để chạy lại script không xoá trạng thái HELD/SOLD.
    const existingSnapshot = await seatsCollection.get();
    const existingSeatCodes = new Set(existingSnapshot.docs.map((doc) => doc.id));
    const missingSeats = seats.filter((seat) => !existingSeatCodes.has(seat.seatCode));

    // Firestore batch tối đa 500 operations; chạy từng suất theo 3 batch song song.
    const BATCH_SIZE = 400;
    const writes = [];

    for (let i = 0; i < missingSeats.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const chunk = missingSeats.slice(i, i + BATCH_SIZE);

        for (const seat of chunk) {
            batch.create(seatsCollection.doc(seat.seatCode), {
                ...seat,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp()
            });
        }

        writes.push(batch.commit());
    }

    await Promise.all(writes);

    // Đánh dấu đã seed đủ để lần chạy sau bỏ qua suất này ngay từ đầu.
    await showtimeRef.set({
        seatsSeeded: true,
        seatCount: seats.length
    }, { merge: true });

    console.log(
        `Suất ${showtimeId}: đã có ${existingSeatCodes.size}, tạo thêm ${missingSeats.length} ghế.`
    );
}


async function seedSeats() {
    const seats = buildSeats();
    const showtimeIds = buildShowtimeIds();

    console.log(`Đã tạo ${seats.length} ghế trong bộ nhớ.`);
    console.log(`Chuẩn bị seed ${showtimeIds.length} suất diễn.`);

    for (const showtimeId of showtimeIds) {
        const { showtimeRef, showtimeSnap } = await seedShowAndShowtime(showtimeId);
        await seedSeatsForShowtime(showtimeRef, showtimeSnap, showtimeId, seats);
    }


    console.log("");
    console.log("=================================");
    console.log("SEED GHẾ THÀNH CÔNG");
    console.log("=================================");
    console.log(`Show: ${SHOW_ID}`);
    console.log(`Số suất diễn: ${showtimeIds.length}`);
    console.log(`Tổng ghế: ${seats.length}`);
    console.log("=================================");

    process.exit(0);
}


// ==========================================
// CHẠY SCRIPT
// ==========================================

seedSeats().catch(error => {

    console.error("");
    console.error("LỖI KHI SEED GHẾ:");
    console.error(error);

    process.exit(1);
});