const path = require("path");

require("dotenv").config({
    path: path.resolve(__dirname, "../.env")
});

const { reconcilePendingOrders } = require("../src/services/reconcile.service");

// ==========================================
// CLI ĐỐI SOÁT ĐƠN TREO (C6) — xem chi tiết trong reconcile.service.js.
//
// CHẠY:
//   node scripts/reconcilePendingOrders.js            -> DRY-RUN (chỉ xem, KHÔNG chốt)
//   node scripts/reconcilePendingOrders.js --commit   -> CHỐT THẬT (cấp vé + gửi mail)
// ==========================================

const COMMIT = process.argv.includes("--commit");

(async () => {
    console.log("=================================");
    console.log(`Đối soát đơn treo — chế độ: ${COMMIT ? "CHỐT THẬT (cấp vé + gửi mail)" : "DRY-RUN (chỉ xem)"}`);
    console.log("=================================");

    const r = await reconcilePendingOrders({ commit: COMMIT, log: (m) => console.log(m) });

    console.log("=================================");
    console.log(`Tổng đơn PENDING: ${r.total}`);
    console.log(`Đã trả (PayOS PAID): ${r.paid}${COMMIT ? ` — đã chốt ${r.committed}` : " — chạy lại với --commit để chốt"}`);
    console.log(`Chưa trả / trạng thái khác: ${r.other}`);
    console.log(`Lỗi khi hỏi PayOS (thường là đơn test/mã không tồn tại): ${r.failed}`);
    console.log("=================================");

    process.exit(0);
})().catch((error) => {
    console.error("LỖI ĐỐI SOÁT:", error);
    process.exit(1);
});
