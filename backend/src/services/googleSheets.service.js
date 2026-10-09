const path = require("path");
const { google } = require("googleapis");

// Đẩy lịch sử quét vé (gateScanHistory, xem logGateScan() trong admin.service.js)
// lên Google Sheet để venue xem được mà không cần vào Firestore Console. Dùng lại
// CHÍNH service account Firebase hiện có (serviceAccountKey.json) — chỉ cần share
// quyền Editor trên Sheet cho email service account, không tạo bí mật mới.
const SHEET_ID = process.env.GATE_SCAN_SHEET_ID || "";

const HEADER_ROW = [
    "Giờ quét", "Mã vé", "Khách hàng", "Ghế", "Suất diễn",
    "Kết quả", "Đã check-in / Tổng", "Ghi chú"
];

let sheetsClient = null;
function getSheetsClient() {
    if (sheetsClient) return sheetsClient;

    const serviceAccountFile = process.env.FIREBASE_SERVICE_ACCOUNT_FILE || "serviceAccountKey.json";
    const serviceAccountPath = path.resolve(__dirname, "../../", serviceAccountFile);
    const auth = new google.auth.GoogleAuth({
        keyFile: serviceAccountPath,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    sheetsClient = google.sheets({ version: "v4", auth });
    return sheetsClient;
}

// Tên tab theo ngày Việt Nam, khớp đúng quy ước đã có ("Checkin 9/10") — D/M
// không zero-pad, giống cách người dùng tự đặt tên tab đầu tiên.
function tabTitleForDate(date) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Ho_Chi_Minh", day: "numeric", month: "numeric"
    }).formatToParts(date);
    // Intl vẫn zero-pad dù để "numeric" (tuỳ ICU) — ép parseInt để chắc chắn bỏ
    // số 0 đầu, khớp đúng tên tab "Checkin 9/10" người dùng tự tạo (không phải
    // "Checkin 09/10").
    const day = parseInt(parts.find((p) => p.type === "day").value, 10);
    const month = parseInt(parts.find((p) => p.type === "month").value, 10);
    return `Checkin ${day}/${month}`;
}

// sheetId (numeric, khác title) cần cho request format header — cache theo
// title để khỏi gọi spreadsheets.get() lại mỗi lần quét.
const tabSheetIds = new Map();

async function ensureTabExists(sheets, title) {
    if (tabSheetIds.has(title)) return tabSheetIds.get(title);

    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    let sheet = (meta.data.sheets || []).find((s) => s.properties.title === title);

    if (!sheet) {
        const created = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: { requests: [{ addSheet: { properties: { title } } }] }
        });
        sheet = created.data.replies[0].addSheet;
        const sheetId = sheet.properties.sheetId;

        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: `'${title}'!A1`,
            valueInputOption: "RAW",
            requestBody: { values: [HEADER_ROW] }
        });

        // Tab mới -> bôi nền xanh cho cả dòng tên cột (row 1), chữ trắng đậm
        // cho dễ phân biệt với dữ liệu bên dưới. Phủ rộng tới cột L để luôn
        // trùm luôn khối tổng hợp J/K dù dòng 1 bên đó có dữ liệu hay chưa.
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: {
                requests: [{
                    repeatCell: {
                        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 },
                        cell: {
                            userEnteredFormat: {
                                backgroundColor: { red: 0.16, green: 0.4, blue: 0.85 },
                                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                            }
                        },
                        fields: "userEnteredFormat(backgroundColor,textFormat)"
                    }
                }]
            }
        });
    }

    tabSheetIds.set(title, sheet.properties.sheetId);
    return sheet.properties.sheetId;
}

async function appendGateScanRow({
    scannedAt, ticketCode, customerName, seats, showtimeId, checkedInCount, totalCount, message
}) {
    if (!SHEET_ID) return; // Chưa cấu hình GATE_SCAN_SHEET_ID — bỏ qua, không throw.

    const sheets = getSheetsClient();
    const title = tabTitleForDate(scannedAt);
    await ensureTabExists(sheets, title);

    const timeLabel = new Intl.DateTimeFormat("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(scannedAt);

    await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `'${title}'!A:H`,
        valueInputOption: "RAW",
        // OVERWRITE (không phải INSERT_ROWS) — chỉ ghi vào dòng trống tiếp theo
        // trong đúng cột A:H, KHÔNG chèn/đẩy nguyên hàng xuống. Quan trọng vì
        // cột J/K bên cạnh giữ khối tổng hợp cố định ở đầu bảng — INSERT_ROWS
        // sẽ đẩy khối đó trôi xuống dần theo mỗi lượt quét.
        insertDataOption: "OVERWRITE",
        requestBody: {
            values: [[
                timeLabel,
                ticketCode || "",
                customerName || "",
                (seats || []).join(", "),
                showtimeId || "",
                "Thành Công", // chỉ gọi hàm này khi checkedInCount > 0 (xem admin.service.js)
                `${checkedInCount || 0}/${totalCount || 0}`,
                message || ""
            ]]
        }
    });
}

// Khối tổng hợp "đã quét/đã bán" theo suất + theo hạng, ghim cố định ở J1:K6
// (không nằm trong vùng A:H nên không bị cuốn theo mỗi lần append). Ghi đè
// toàn bộ mỗi lần gọi — luôn phản ánh đúng tổng mới nhất.
async function writeShowtimeSummary({ scannedAt, showtimeId, totalSold, totalCheckedIn, tiers }) {
    if (!SHEET_ID) return;

    const sheets = getSheetsClient();
    const title = tabTitleForDate(scannedAt);
    await ensureTabExists(sheets, title);

    const rows = [
        ["Suất diễn", showtimeId || ""],
        ["Đã quét / Đã bán", `${totalCheckedIn}/${totalSold}`],
        ...tiers.map((t) => [t.label, `${t.checkedIn}/${t.sold}`])
    ];

    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `'${title}'!J1:K${rows.length}`,
        valueInputOption: "RAW",
        requestBody: { values: rows }
    });
}

module.exports = { appendGateScanRow, writeShowtimeSummary };
