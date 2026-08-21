const { db } = require("../src/config/firebase");
const { FieldValue } = require("firebase-admin/firestore");


// ==========================================
// CẤU HÌNH SHOW / SUẤT DIỄN
// ==========================================

const SHOW_ID = "son-than-thuy-quai";

const SHOWTIME_ID = "2026-09-25_17:30";


// ==========================================
// HẠNG GHẾ
// Lấy theo BookingTicket.html
// ==========================================

const TIERS = {
    // TẠM THỜI hạ giá về 2.000đ để dễ test thanh toán thật qua PayOS —
    // nhớ đổi lại giá thật trước khi lên production.
    "son-than": {
        name: "Sơn Thần",
        price: 2000
    },

    "thuy-quai": {
        name: "Thủy Quái",
        price: 2000
    },

    "mi-nuong": {
        name: "Mị Nương",
        price: 2000
    }
};


// ==========================================
// HÀNG GHẾ
// Chỉ cần code + tổng số ghế cho Firestore
// ==========================================

const ROWS = [
    { code: "B", total: 64 },
    { code: "C", total: 78 },
    { code: "D", total: 88 },
    { code: "E", total: 98 },

    { code: "G", total: 106 },
    { code: "H", total: 108 },
    { code: "I", total: 86 },
    { code: "K", total: 116 },

    { code: "L", total: 128 },
    { code: "M", total: 130 },
    { code: "N", total: 96 },
    { code: "O", total: 92 },
    { code: "P", total: 96 }
];


const NEAR_ROWS = new Set(["B", "C", "D", "E"]);

const MID_ROWS = new Set(["G", "H", "I", "K"]);


function tierOf(rowCode) {
    if (NEAR_ROWS.has(rowCode)) {
        return "son-than";
    }

    if (MID_ROWS.has(rowCode)) {
        return "thuy-quai";
    }

    return "mi-nuong";
}


// ==========================================
// TẠO DANH SÁCH GHẾ
// ==========================================

function buildSeats() {
    const seats = [];

    for (const row of ROWS) {

        const tier = tierOf(row.code);
        const price = TIERS[tier].price;

        for (let number = 1; number <= row.total; number++) {

            seats.push({
                seatCode: `${row.code}${number}`,
                row: row.code,
                number: number,

                side: number % 2 === 1
                    ? "odd"
                    : "even",

                tier: tier,
                tierName: TIERS[tier].name,

                price: price,

                status: "AVAILABLE",

                holdId: null,
                holdExpiresAt: null
            });
        }
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