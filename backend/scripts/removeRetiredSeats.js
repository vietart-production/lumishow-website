const { db } = require("../src/config/firebase");

// ==========================================
// XOÁ GHẾ ĐÃ BỊ LOẠI BỎ KHỎI SÂN KHẤU THẬT
// ------------------------------------------
// P43,45,47 (bên lẻ) và P44,46,48 (bên chẵn) không còn tồn tại ở rạp thật
// (đã tháo bỏ) — xoá hẳn document ghế thay vì chỉ set SOLD, để không còn
// hiện lên sơ đồ ghế dưới bất kỳ hình thức nào.
//
// seatTiers.json và SEAT_XY (frontend/dat-ve.html) đã bỏ các mã ghế này
// nên suất diễn tạo mới bằng seedSeats.js không còn sinh ra chúng nữa —
// script này chỉ cần chạy lại để backfill các suất diễn đã seed từ trước
// khi có thay đổi này, hoặc nếu venue báo tháo thêm ghế khác sau này (sửa
// RETIRED_SEATS bên dưới rồi chạy lại).
// ==========================================

const SHOW_ID = "son-than-thuy-quai";
const RETIRED_SEATS = ["P43", "P44", "P45", "P46", "P47", "P48"];

async function removeRetiredSeats() {
    const showtimesSnap = await db
        .collection("shows").doc(SHOW_ID)
        .collection("showtimes")
        .get();

    console.log(`Tìm thấy ${showtimesSnap.size} suất diễn.`);

    let deleted = 0;
    let alreadyGone = 0;
    let blockedNonAvailable = 0;

    for (const showtimeDoc of showtimesSnap.docs) {
        const seatsCollection = showtimeDoc.ref.collection("seats");

        const seatSnaps = await Promise.all(
            RETIRED_SEATS.map((code) => seatsCollection.doc(code).get())
        );

        const batch = db.batch();
        let batchHasWrites = false;

        for (const seatSnap of seatSnaps) {
            if (!seatSnap.exists) { alreadyGone++; continue; }

            const status = seatSnap.data().status;

            if (status !== "AVAILABLE") {
                // Ghế đang HELD hoặc đã SOLD (có khách thật) — không tự ý xoá,
                // cần xử lý tay (huỷ vé/hoàn tiền) trước.
                blockedNonAvailable++;
                console.log(`  BỎ QUA ${showtimeDoc.id}/${seatSnap.id}: đang ${status}, cần xử lý tay trước khi xoá.`);
                continue;
            }

            batch.delete(seatSnap.ref);
            batchHasWrites = true;
            deleted++;
        }

        if (batchHasWrites) await batch.commit();
    }

    console.log("=================================");
    console.log(`Đã xoá: ${deleted} ghế`);
    console.log(`Vốn đã không tồn tại (bỏ qua): ${alreadyGone} ghế`);
    console.log(`Bỏ qua vì đang HELD/SOLD: ${blockedNonAvailable} ghế`);
    console.log("=================================");

    process.exit(0);
}

removeRetiredSeats().catch((error) => {
    console.error("LỖI KHI XOÁ GHẾ:", error);
    process.exit(1);
});
