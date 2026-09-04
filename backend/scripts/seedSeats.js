const { db } = require("../src/config/firebase");
const { FieldValue } = require("firebase-admin/firestore");
const SEAT_TIERS = require("./seatTiers.json");


// ==========================================
// CẤU HÌNH SHOW / SUẤT DIỄN
// ==========================================

const SHOW_ID = "son-than-thuy-quai";

const SHOWTIME_ID = "2026-09-25_16:30";


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


// ==========================================
// ĐẨY GHẾ LÊN FIRESTORE
// ==========================================

async function seedShowAndShowtime() {

    const showRef = db.collection("shows").doc(SHOW_ID);

    await showRef.set({
        name: "Sơn Thần Thủy Quái",
        status: "active",
        reserved: 0,
        sold: 0
    }, { merge: true });


    const showtimeRef = showRef
        .collection("showtimes")
        .doc(SHOWTIME_ID);

    await showtimeRef.set({
        status: "OPEN"
    }, { merge: true });

    console.log(`Đã tạo/cập nhật show "${SHOW_ID}" và showtime "${SHOWTIME_ID}".`);
}


async function seedSeats() {

    await seedShowAndShowtime();

    const seats = buildSeats();

    console.log(`Đã tạo ${seats.length} ghế trong bộ nhớ.`);


    const seatsCollection = db
        .collection("shows")
        .doc(SHOW_ID)
        .collection("showtimes")
        .doc(SHOWTIME_ID)
        .collection("seats");


    // Firestore batch tối đa 500 operations
    const BATCH_SIZE = 400;


    for (let i = 0; i < seats.length; i += BATCH_SIZE) {

        const batch = db.batch();

        const chunk = seats.slice(i, i + BATCH_SIZE);


        for (const seat of chunk) {

            const seatRef = seatsCollection.doc(seat.seatCode);

            batch.set(seatRef, {
                ...seat,

                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp()
            });
        }


        await batch.commit();

        console.log(
            `Đã ghi ghế ${i + 1} → ${Math.min(
                i + BATCH_SIZE,
                seats.length
            )}`
        );
    }


    console.log("");
    console.log("=================================");
    console.log("SEED GHẾ THÀNH CÔNG");
    console.log("=================================");
    console.log(`Show: ${SHOW_ID}`);
    console.log(`Showtime: ${SHOWTIME_ID}`);
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