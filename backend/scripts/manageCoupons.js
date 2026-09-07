const { db } = require("../src/config/firebase");
const { FieldValue } = require("firebase-admin/firestore");

// ==========================================
// QUẢN LÝ MÃ GIẢM GIÁ (COUPON) QUA CLI
// ------------------------------------------
// Firestore: coupons/{CODE} — xem chi tiết field ở
// backend/src/services/coupon.service.js.
//
// Cách dùng:
//   node scripts/manageCoupons.js create SALE10 10
//   node scripts/manageCoupons.js create SALE10 10 --max 100
//   node scripts/manageCoupons.js create SALE10 10 --max 100 --expires 2026-12-31
//   node scripts/manageCoupons.js list
//   node scripts/manageCoupons.js deactivate SALE10
//   node scripts/manageCoupons.js activate SALE10
// ==========================================

function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--")) {
            const key = args[i].slice(2);
            const value = args[i + 1];
            flags[key] = value;
            i++;
        }
    }
    return flags;
}

function normalizeCode(rawCode) {
    return String(rawCode || "").trim().toUpperCase();
}

async function createCoupon(args) {
    const [rawCode, rawPercent] = args;
    const flags = parseFlags(args.slice(2));

    const code = normalizeCode(rawCode);
    const percentOff = Number(rawPercent);

    if (!code) {
        throw new Error("Thiếu mã coupon. Ví dụ: create SALE10 10");
    }

    if (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 100) {
        throw new Error("percentOff phải là số trong khoảng 1-100.");
    }

    const maxUses = flags.max != null ? Number(flags.max) : null;
    if (flags.max != null && (!Number.isFinite(maxUses) || maxUses <= 0)) {
        throw new Error("--max phải là số nguyên dương.");
    }

    let expiresAt = null;
    if (flags.expires) {
        const parsed = new Date(flags.expires);
        if (Number.isNaN(parsed.getTime())) {
            throw new Error("--expires phải theo định dạng YYYY-MM-DD.");
        }
        expiresAt = parsed;
    }

    const ref = db.collection("coupons").doc(code);
    const existing = await ref.get();

    await ref.set({
        code,
        percentOff,
        active: true,
        maxUses,
        usedCount: existing.exists ? (existing.data().usedCount || 0) : 0,
        expiresAt,
        createdAt: existing.exists ? existing.data().createdAt : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(
        `${existing.exists ? "Đã cập nhật" : "Đã tạo"} coupon "${code}": giảm ${percentOff}%` +
        (maxUses ? `, tối đa ${maxUses} lượt` : ", không giới hạn lượt") +
        (expiresAt ? `, hết hạn ${expiresAt.toISOString().slice(0, 10)}` : ", không giới hạn hạn dùng")
    );
}

async function setActive(args, active) {
    const code = normalizeCode(args[0]);
    if (!code) {
        throw new Error("Thiếu mã coupon.");
    }

    const ref = db.collection("coupons").doc(code);
    const snap = await ref.get();

    if (!snap.exists) {
        throw new Error(`Không tìm thấy coupon "${code}".`);
    }

    await ref.update({ active, updatedAt: FieldValue.serverTimestamp() });
    console.log(`Coupon "${code}" đã ${active ? "kích hoạt lại" : "tạm ngừng"}.`);
}

async function listCoupons() {
    const snapshot = await db.collection("coupons").orderBy("createdAt", "desc").get();

    if (snapshot.empty) {
        console.log("Chưa có coupon nào.");
        return;
    }

    console.log(`Tổng ${snapshot.size} coupon:\n`);

    snapshot.forEach((doc) => {
        const d = doc.data();
        const expires = d.expiresAt?.toDate ? d.expiresAt.toDate().toISOString().slice(0, 10) : (d.expiresAt || "—");
        const used = `${d.usedCount || 0}${d.maxUses != null ? "/" + d.maxUses : ""}`;

        console.log(
            `${doc.id.padEnd(16)} ` +
            `${String(d.percentOff).padStart(3)}%  ` +
            `${d.active ? "active  " : "inactive"}  ` +
            `dùng: ${used.padEnd(9)} ` +
            `hết hạn: ${expires}`
        );
    });
}

async function main() {
    const [, , command, ...args] = process.argv;

    switch (command) {
        case "create":
            await createCoupon(args);
            break;
        case "list":
            await listCoupons();
            break;
        case "activate":
            await setActive(args, true);
            break;
        case "deactivate":
            await setActive(args, false);
            break;
        default:
            console.log("Lệnh không hợp lệ. Dùng: create | list | activate | deactivate");
            console.log("Ví dụ: node scripts/manageCoupons.js create SALE10 10 --max 100 --expires 2026-12-31");
            process.exitCode = 1;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("LỖI:", error.message);
        process.exit(1);
    });
