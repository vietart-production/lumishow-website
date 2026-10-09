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
    const day = parts.find((p) => p.type === "day").value;
    const month = parts.find((p) => p.type === "month").value;
    return `Checkin ${day}/${month}`;
}

const knownTabs = new Set();

async function ensureTabExists(sheets, title) {
    if (knownTabs.has(title)) return;

    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const exists = (meta.data.sheets || []).some((s) => s.properties.title === title);

    if (!exists) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: { requests: [{ addSheet: { properties: { title } } }] }
        });
        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: `'${title}'!A1`,
            valueInputOption: "RAW",
            requestBody: { values: [HEADER_ROW] }
        });
    }

    knownTabs.add(title);
}

async function appendGateScanRow({
    scannedAt, ticketCode, customerName, seats, showtimeId,
    outcome, checkedInCount, totalCount, message
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
        insertDataOption: "INSERT_ROWS",
        requestBody: {
            values: [[
                timeLabel,
                ticketCode || "",
                customerName || "",
                (seats || []).join(", "),
                showtimeId || "",
                outcome || "",
                `${checkedInCount || 0}/${totalCount || 0}`,
                message || ""
            ]]
        }
    });
}

module.exports = { appendGateScanRow };
