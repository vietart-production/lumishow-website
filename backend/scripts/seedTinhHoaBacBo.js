const { db } = require("../src/config/firebase");
const { FieldValue } = require("firebase-admin/firestore");

// ==========================================
// SEED SUẤT DIỄN + "VÉ ẢO" CHO SHOW "TINH HOA BẮC BỘ" (nhánh extend_ShowTHBB)
// ------------------------------------------
// Show này KHÔNG bán theo ghế cụ thể (không có sơ đồ ghế/toạ độ như Sơn Thần
// Thủy Quái) — chỉ bán SỐ LƯỢNG vé theo hạng (Platinum/Gold/Silver), khách
// tự tìm tới khu vực đúng hạng rồi tự chọn chỗ trống mà ngồi (xem ảnh "Phân
// bổ sức chứa theo từng hạng ghế" user cung cấp — KHÔNG vẽ icon ghế/sơ đồ
// như dat-ve.html, chỉ bán số lượng).
//
// Vẫn mô hình hoá mỗi vé là 1 document trong "seats" subcollection — GIỐNG
// HỆT cơ chế ghế thật của Sơn Thần Thủy Quái — để tái dùng nguyên vẹn toàn
// bộ pipeline giữ-chỗ/thanh toán/tạo vé/check-in (booking.service.js,
// payment.service.js, admin.service.js), không sửa gì ở backend. Khác biệt
// DUY NHẤT: seatId đặt theo hạng + loại vé + số thứ tự (vd "SILVER-007",
// "GOLD-CHILD-012") thay vì mã ghế thật.
//
// GIÁ THEO NGÀY DIỄN: show diễn cố định Thứ 4/Thứ 7/Chủ Nhật hàng tuần —
// suất Thứ 4 có giá rẻ hơn (giảm ~10%) so với suất Thứ 7/CN. Giá trẻ em
// (90cm-<1m3): đúng 50% giá người lớn CÙNG hạng + CÙNG loại ngày. Trẻ em
// dưới 90cm miễn phí, ngồi chung ghế người lớn — KHÔNG seed vé riêng cho
// nhóm này (không chiếm chỗ, không thu tiền, không cần theo dõi trong hệ
// thống vé). Trẻ em từ 1m3 trở lên tính như người lớn — mua thẳng vé loại
// "adult", không cần loại vé riêng.
//
// SỨC CHỨA (vé "child") CHƯA CÓ SỐ THẬT TÁCH RIÊNG — venue chỉ cho biết tổng
// sức chứa mỗi hạng (Platinum 50 / Gold 840 / Silver 900), không tách sẵn
// bao nhiêu trong số đó dành cho trẻ em (ghế vật lý dùng chung giữa người
// lớn/trẻ em, ai mua trước được trước). ĐƠN GIẢN HOÁ CHO BẢN DEMO: để pool
// "child" dùng chung CÙNG sức chứa với "adult" của hạng đó — nghĩa là tổng
// 2 pool có thể cộng lại vượt sức chứa thật nếu bán hết cả 2 cùng lúc (rất
// hiếm xảy ra thực tế vì trẻ em luôn là thiểu số). Khi có số thật (vd venue
// xác nhận tối đa X% là trẻ em) thì sửa lại CHILD_CAPACITY_RATIO bên dưới.
//
// 1 CHỖ PLACEHOLDER CÒN LẠI — SỬA LẠI KHI CÓ THẬT:
//   - Tên/địa chỉ venue thật — xem SHOW_DISPLAY trong email.service.js.
// ==========================================

const SHOW_ID = "tinh-hoa-bac-bo";
const SHOWTIME_TIME = "19:30"; // xác nhận thật: 19h30-20h45 (75 phút)

// 8 suất đều đặn Thứ 4/7/CN tháng 11-12/2026 (CHƯA gồm 3 đêm diễn tăng
// cường 16/17/20-11 — user chốt làm sau, không nằm trong phạm vi lần này).
const DATES = [
    "2026-11-18", "2026-11-21", "2026-11-22",
    "2026-11-25", "2026-11-28", "2026-11-29",
    "2026-12-02", "2026-12-05"
];

// Sức chứa thật theo venue xác nhận — xem ảnh "Phân bổ sức chứa theo từng
// hạng ghế" (Platinum: 3 khoang riêng biệt tầng cao, có mái che; Gold: khu
// trung tâm đối diện sân khấu; Silver: hai cánh trái/phải).
const CHILD_CAPACITY_RATIO = 1; // PLACEHOLDER — xem comment ở trên, tạm dùng chung 100% sức chứa hạng đó

const TIERS = {
    platinum: { name: "Platinum (Bạch Kim)", capacity: 50, weekdayAdult: 810000, weekendAdult: 900000 },
    gold: { name: "Gold (Vàng)", capacity: 840, weekdayAdult: 540000, weekendAdult: 600000 },
    silver: { name: "Silver (Bạc)", capacity: 900, weekdayAdult: 450000, weekendAdult: 500000 }
};

// Thứ 4 (dow=3) = "weekday" (giá rẻ hơn); Thứ 7 (6)/Chủ Nhật (0) = "weekend".
// Show này chỉ diễn đúng 3 ngày/tuần nên không cần xử lý các dow khác.
function dayTypeOf(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    return dow === 3 ? "weekday" : "weekend";
}

function buildVirtualSeatsFor(dayType) {
    const seats = [];

    for (const [tier, info] of Object.entries(TIERS)) {
        const adultPrice = dayType === "weekday" ? info.weekdayAdult : info.weekendAdult;
        const childPrice = Math.round(adultPrice / 2); // đúng 50%, khớp bảng giá venday cung cấp

        for (let i = 1; i <= info.capacity; i++) {
            seats.push({
                seatCode: `${tier.toUpperCase()}-${String(i).padStart(3, "0")}`,
                tier, ageType: "adult",
                tierName: `${info.name} - Người lớn`,
                price: adultPrice,
                status: "AVAILABLE", holdId: null, holdExpiresAt: null
            });
        }

        const childCapacity = Math.round(info.capacity * CHILD_CAPACITY_RATIO);
        for (let i = 1; i <= childCapacity; i++) {
            seats.push({
                seatCode: `${tier.toUpperCase()}-CHILD-${String(i).padStart(3, "0")}`,
                tier, ageType: "child",
                tierName: `${info.name} - Trẻ em (90cm-dưới 1m3)`,
                price: childPrice,
                status: "AVAILABLE", holdId: null, holdExpiresAt: null
            });
        }
    }

    return seats;
}

async function seedShowtime(showtimeId, seats) {

    const showRef = db.collection("shows").doc(SHOW_ID);
    await showRef.set({ name: "Tinh Hoa Bắc Bộ", status: "active" }, { merge: true });

    const showtimeRef = showRef.collection("showtimes").doc(showtimeId);
    const showtimeSnap = await showtimeRef.get();

    if (!showtimeSnap.exists) {
        await showtimeRef.set({ status: "OPEN" });
        console.log(`Đã tạo showtime "${showtimeId}" (status OPEN).`);
    } else {
        console.log(`Showtime "${showtimeId}" đã tồn tại, giữ nguyên status hiện tại.`);
    }

    const showtimeData = showtimeSnap.data() || {};
    if (showtimeData.seatsSeeded === true && showtimeData.seatCount === seats.length) {
        console.log(`Suất ${showtimeId}: đã seed đủ ${seats.length} vé ảo từ trước, bỏ qua.`);
        return;
    }

    const seatsCollection = showtimeRef.collection("seats");
    const existingSnapshot = await seatsCollection.get();
    const existingSeatCodes = new Set(existingSnapshot.docs.map((doc) => doc.id));
    const missingSeats = seats.filter((seat) => !existingSeatCodes.has(seat.seatCode));

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

    await showtimeRef.set({ seatsSeeded: true, seatCount: seats.length }, { merge: true });

    console.log(`Suất ${showtimeId}: đã có ${existingSeatCodes.size}, tạo thêm ${missingSeats.length} vé ảo.`);
}

async function seedTinhHoaBacBo() {

    console.log(`Chuẩn bị seed ${DATES.length} suất diễn, giờ diễn ${SHOWTIME_TIME}.`);

    for (const date of DATES) {
        const dayType = dayTypeOf(date);
        const seats = buildVirtualSeatsFor(dayType);
        const showtimeId = `${date}_${SHOWTIME_TIME}`;
        console.log(`\n${showtimeId} (${dayType === "weekday" ? "Thứ 4 — giá rẻ hơn" : "Cuối tuần"}): ${seats.length} vé ảo.`);
        await seedShowtime(showtimeId, seats);
    }

    console.log("");
    console.log("=================================");
    console.log("SEED TINH HOA BẮC BỘ THÀNH CÔNG");
    console.log("=================================");
    console.log(`Show: ${SHOW_ID}`);
    console.log(`Số suất diễn: ${DATES.length}`);
    console.log("=================================");

    process.exit(0);
}

seedTinhHoaBacBo().catch((error) => {
    console.error("");
    console.error("LỖI KHI SEED TINH HOA BẮC BỘ:");
    console.error(error);
    process.exit(1);
});
