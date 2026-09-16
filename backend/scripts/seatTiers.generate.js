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

        const row = seatCode.match(/^([A-Z]+)/)[1];
        const front = y > CY;

        let tier;
        if (front && INNER_ROWS.has(row)) tier = "son-than";
        else if (front && OUTER_ROWS.has(row)) tier = "thuy-quai";
        else tier = "mi-nuong";

        tiers[seatCode] = tier;
        counts[tier]++;
    }

    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(tiers));

    console.log(`Đã sinh ${Object.keys(tiers).length} ghế → ${OUTPUT_JSON}`);
    console.log("Phân bố hạng ghế:", counts);
}

main();
