require("dotenv").config();
const { db } = require("../src/config/firebase");

// ==========================================
// XOÁ SẠCH DỮ LIỆU "TINH HOA BẮC BỘ" (nhánh extend_ShowTHBB) — RÚT LẠI KHI
// KHÔNG BÁN VÉ SHOW NÀY NỮA.
// ------------------------------------------
// Toàn bộ dữ liệu của show này đã CỐ Ý thiết kế để cô lập, dễ rút gọn:
//   - "Vé ảo" (seats) + showtimes nằm RIÊNG dưới shows/tinh-hoa-bac-bo —
//     không đụng tới/không bị show Sơn Thần Thủy Quái tham chiếu tới, xoá
//     nguyên cây này không ảnh hưởng gì tới dữ liệu show kia.
//   - orders/tickets/holds là collection top-level dùng chung giữa mọi show
//     (đúng kiến trúc gốc của hệ thống, xem CLAUDE.md) nhưng MỌI document
//     đều có field showId — lọc theo showId=="tinh-hoa-bac-bo" là đủ để
//     tìm và xoá đúng, không lẫn dữ liệu show thật.
//
// Script này xoá theo đúng thứ tự: tickets -> orders -> holds -> seats mỗi
// showtime -> showtimes -> doc show gốc.
//
// MẶC ĐỊNH CHỈ "DRY RUN" (đếm & liệt kê, KHÔNG xoá gì) — giống quy ước
// reconcilePendingOrders.js. Chạy thật:
//   node scripts/removeTinhHoaBacBo.js --commit
// ==========================================

const SHOW_ID = "tinh-hoa-bac-bo";
const COMMIT = process.argv.includes("--commit");
const BATCH_SIZE = 400;

async function deleteDocsInBatches(docRefs, label) {
    console.log(`${label}: ${docRefs.length} document${COMMIT ? "" : " (DRY RUN — chưa xoá)"}`);
    if (!COMMIT || docRefs.length === 0) return;

    for (let i = 0; i < docRefs.length; i += BATCH_SIZE) {
        const batch = db.batch();
        docRefs.slice(i, i + BATCH_SIZE).forEach((ref) => batch.delete(ref));
        await batch.commit();
    }
    console.log(`  -> đã xoá xong ${docRefs.length} document.`);
}

async function removeTinhHoaBacBo() {

    // 1. tickets (top-level, lọc theo showId)
    const ticketsSnap = await db.collection("tickets").where("showId", "==", SHOW_ID).get();
    await deleteDocsInBatches(ticketsSnap.docs.map((d) => d.ref), "tickets");

    // 2. orders (top-level, lọc theo showId)
    const ordersSnap = await db.collection("orders").where("showId", "==", SHOW_ID).get();
    await deleteDocsInBatches(ordersSnap.docs.map((d) => d.ref), "orders");

    // 3. holds (top-level, lọc theo showId) — đề phòng còn hold ACTIVE/EXPIRED chưa dọn
    const holdsSnap = await db.collection("holds").where("showId", "==", SHOW_ID).get();
    await deleteDocsInBatches(holdsSnap.docs.map((d) => d.ref), "holds");

    // 4. seats + showtimes dưới shows/tinh-hoa-bac-bo
    const showRef = db.collection("shows").doc(SHOW_ID);
    const showtimesSnap = await showRef.collection("showtimes").get();

    let totalSeats = 0;
    for (const showtimeDoc of showtimesSnap.docs) {
        const seatsSnap = await showtimeDoc.ref.collection("seats").get();
        totalSeats += seatsSnap.size;
        await deleteDocsInBatches(seatsSnap.docs.map((d) => d.ref), `  seats của suất ${showtimeDoc.id}`);
    }
    await deleteDocsInBatches(showtimesSnap.docs.map((d) => d.ref), "showtimes");

    // 5. doc show gốc
    const showSnap = await showRef.get();
    console.log(`show doc "${SHOW_ID}": ${showSnap.exists ? 1 : 0} document${COMMIT ? "" : " (DRY RUN — chưa xoá)"}`);
    if (COMMIT && showSnap.exists) {
        await showRef.delete();
        console.log("  -> đã xoá xong.");
    }

    console.log("");
    console.log("=================================");
    console.log(COMMIT ? "ĐÃ XOÁ SẠCH TINH HOA BẮC BỘ" : "DRY RUN XONG — chạy lại kèm --commit để xoá thật");
    console.log("=================================");
    console.log(`tickets: ${ticketsSnap.size} | orders: ${ordersSnap.size} | holds: ${holdsSnap.size}`);
    console.log(`showtimes: ${showtimesSnap.size} | tổng vé ảo: ${totalSeats}`);
    console.log("=================================");

    process.exit(0);
}

removeTinhHoaBacBo().catch((error) => {
    console.error("");
    console.error("LỖI KHI XOÁ TINH HOA BẮC BỘ:");
    console.error(error);
    process.exit(1);
});
