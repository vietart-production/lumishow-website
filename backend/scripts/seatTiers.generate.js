// Sinh lại backend/scripts/seatTiers.json từ toạ độ ghế thật trong
// frontend/dat-ve.html (SEAT_XY). Chạy: node scripts/seatTiers.generate.js
//
// Quy tắc hạng ghế (theo yêu cầu thực tế của venue):
//   - Ghế "phía trước" (đối diện sân khấu — y > CY trong hệ toạ độ SVG):
//       hàng B,C,D,E,G,H,I → "son-than" (Sơn Thần, giá cao nhất)
//       hàng K,L,M,N       → "thuy-quai" (Thủy Quái, giá giữa)
//       hàng O,P           → "mi-nuong" (đổi theo yêu cầu venue 2026-09-16,
//                             trước đó là "thuy-quai" như K,L,M,N)
//   - Ghế "phía sau" (mọi hàng, gồm cả O,P) → "mi-nuong" (Mị Nương, giá thấp nhất)
//   - Ngoại lệ: ở PHÍA SAU, dải ghế theo EXIT_SIDE_UPGRADE (10 hàng B→M, đọc
//     từ bảng số ghế thật venue gửi 2026-09-16 — lẻ/chẵn biên khác nhau nên
//     tách riêng) cũng là "thuy-quai" thay vì "mi-nuong" — front vẫn được
//     check trước nên không bị ghi đè sai.
// "Phía trước/phía sau" xác định bằng dấu của (y - CY): polar(r,deg) dùng
// deg=180 là hướng xuống dưới (phía trước, gần lối vào khán giả), deg=0 là
// hướng lên trên (phía sau, gần sân khấu/hậu trường) — xem hàm polar() và
// entryStart/hauTruongEnd trong frontend/dat-ve.html.

const fs = require("fs");
const path = require("path");

const FRONTEND_HTML = path.resolve(__dirname, "../../frontend/dat-ve.html");
const OUTPUT_JSON = path.resolve(__dirname, "seatTiers.json");

const CY = 680;
const INNER_ROWS = new Set(["B", "C", "D", "E", "G", "H", "I"]);
const OUTER_ROWS = new Set(["K", "L", "M", "N"]);
const EXIT_SIDE_UPGRADE = {
    B: { odd: [35, 61], even: [36, 52] }, C: { odd: [41, 69], even: [42, 62] },
    D: { odd: [61, 75], even: [48, 70] }, E: { odd: [59, 85], even: [42, 80] },
    G: { odd: [53, 87], even: [42, 88] }, H: { odd: [47, 93], even: [60, 94] },
    I: { odd: [41, 65], even: [50, 70] }, K: { odd: [51, 93], even: [74, 94] },
    L: { odd: [73, 101], even: [82, 104] }, M: { odd: [83, 103], even: [86, 106] }
};

function inExitRange(row, num) {
    const exit = EXIT_SIDE_UPGRADE[row];
    if (!exit) return false;
    const r = num % 2 === 1 ? exit.odd : exit.even;
    return num >= r[0] && num <= r[1];
}

function extractSeatXY(html) {

    const startTag = "const SEAT_XY";
    const idx = html.indexOf(startTag);

    if (idx === -1) {
        throw new Error("Không tìm thấy SEAT_XY trong BookingTicket.html");
    }

    const braceStart = html.indexOf("{", idx);
    let depth = 0;
    let i = braceStart;

    for (; i < html.length; i++) {
        if (html[i] === "{") depth++;
        else if (html[i] === "}") {
            depth--;
            if (depth === 0) { i++; break; }
        }
    }

    return JSON.parse(html.slice(braceStart, i));
}

function main() {

    const html = fs.readFileSync(FRONTEND_HTML, "utf8");
    const seatXY = extractSeatXY(html);

    const tiers = {};
    const counts = { "son-than": 0, "thuy-quai": 0, "mi-nuong": 0 };

    for (const [seatCode, [, y]] of Object.entries(seatXY)) {

        const match = seatCode.match(/^([A-Z]+)(\d+)$/);
        const row = match[1];
        const num = parseInt(match[2], 10);
        const front = y > CY;

        let tier;
        if (front && INNER_ROWS.has(row)) tier = "son-than";
        else if (front && OUTER_ROWS.has(row)) tier = "thuy-quai";
        else if (inExitRange(row, num)) tier = "thuy-quai";
        else tier = "mi-nuong";

        tiers[seatCode] = tier;
        counts[tier]++;
    }

    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(tiers));

    console.log(`Đã sinh ${Object.keys(tiers).length} ghế → ${OUTPUT_JSON}`);
    console.log("Phân bố hạng ghế:", counts);
}

main();
