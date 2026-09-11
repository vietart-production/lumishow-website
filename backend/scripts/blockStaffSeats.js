const { db } = require("../src/config/firebase");

// ==========================================
// CHẶN GHẾ HÀNG G DÀNH CHO STAFF/LÃNH ĐẠO
// ------------------------------------------
// G1-G58 (khối ghế "Sơn Thần" đầu hàng G) dành riêng cho staff/lãnh đạo,
// không mở bán công khai. Set status "SOLD" để ghế hiện xám/hết trên sơ đồ
// ghế như ghế đã bán, khách không chọn được.
//
// Suất diễn mới tạo bằng seedSeats.js đã tự seed đúng SOLD cho khối ghế
// này ngay từ đầu (xem STAFF_ROW/STAFF_SEAT_MAX ở đó) — script này chỉ cần
// chạy lại nếu có suất diễn được tạo bằng đường khác mà bỏ qua đó, hoặc để
// backfill các suất diễn đã seed từ trước khi có chặn này.
// ==========================================

const SHOW_ID = "son-than-thuy-quai";
const STAFF_ROW = "G";
const STAFF_SEAT_MAX = 58;

async function blockStaffSeats() {
    const staffSeatCodes = Array.from(
        { length: STAFF_SEAT_MAX },
        (_, i) => `${STAFF_ROW}${i + 1}`
    );

    const showtimesSnap = await db
        .collection("shows").doc(SHOW_ID)
        .collection("showtimes")
        .get();

    console.log(`Tìm thấy ${showtimesSnap.size} suất diễn.`);

    let updated = 0;
    let alreadySold = 0;
    let heldOverridden = 0;

    for (const showtimeDoc of showtimesSnap.docs) {
        const seatsCollection = showtimeDoc.ref.collection("seats");

        const seatSnaps = await Promise.all(
            staffSeatCodes.map((code) => seatsCollection.doc(code).get())
        );

        const now = new Date();
        const batch = db.batch();
        let batchHasWrites = false;

        for (const seatSnap of seatSnaps) {
            if (!seatSnap.exists) continue;

            const status = seatSnap.data().status;

            if (status === "SOLD") {
                alreadySold++;
                continue;
            }

            if (status === "HELD") {
                heldOverridden++;
                console.log(`  ${showtimeDoc.id} / ${seatSnap.id}: đang HELD, ép về SOLD.`);
            }

            batch.update(seatSnap.ref, {
                status: "SOLD",
                holdId: null,
                holdExpiresAt: null,
                updatedAt: now
            });
            batchHasWrites = true;
            updated++;
        }

        if (batchHasWrites) await batch.commit();
    }

    console.log("=================================");
    console.log(`Đã set SOLD: ${updated} ghế`);
    console.log(`Đã SOLD từ trước (bỏ qua): ${alreadySold} ghế`);
    console.log(`Trong đó đang HELD lúc chặn: ${heldOverridden} ghế`);
    console.log("=================================");

    process.exit(0);
}

blockStaffSeats().catch((error) => {
    console.error("LỖI KHI CHẶN GHẾ STAFF:", error);
    process.exit(1);
});
