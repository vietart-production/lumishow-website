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

// sheetId (numeric, khác title) cần cho mọi request batchUpdate định dạng ô —
// cache theo title để khỏi gọi spreadsheets.get() lại mỗi lần quét.
const tabSheetIds = new Map();

async function ensureTabExists(sheets, title) {
    if (tabSheetIds.has(title)) return tabSheetIds.get(title);

    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    let sheet = (meta.data.sheets || []).find((s) => s.properties.title === title);

    if (!sheet) {
        const created = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: {
                requests: [{
                    addSheet: {
                        properties: {
                            title,
                            // Cột A (giờ quét) và D (ghế) rộng hơn hẳn để chứa chữ cỡ lớn —
                            // đây là 2 cột cần "đập vào mắt" nhất khi nhân viên liếc nhanh.
                            gridProperties: { columnCount: 8 }
                        }
                    }
                }]
            }
        });
        sheet = created.data.replies[0].addSheet;

        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: `'${title}'!A1`,
            valueInputOption: "RAW",
            requestBody: { values: [HEADER_ROW] }
        });

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: {
                requests: [
                    {
                        updateDimensionProperties: {
                            range: { sheetId: sheet.properties.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
                            properties: { pixelSize: 160 },
                            fields: "pixelSize"
                        }
                    },
                    {
                        updateDimensionProperties: {
                            range: { sheetId: sheet.properties.sheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 },
                            properties: { pixelSize: 110 },
                            fields: "pixelSize"
                        }
                    }
                ]
            }
        });
    }

    tabSheetIds.set(title, sheet.properties.sheetId);
    return sheet.properties.sheetId;
}

// Format "nổi bật" cho đúng 1 dòng vừa ghi: cột A (giờ quét) + D (ghế) phóng to
// gấp nhiều lần (~3x cỡ chữ thường), in đậm, căn giữa — đây là 2 thông tin nhân
// viên cổng cần liếc thấy ngay từ xa, mọi cột khác giữ cỡ chữ mặc định.
async function highlightRow(sheets, sheetId, rowIndex) {
    const bigFormat = {
        userEnteredFormat: {
            textFormat: { fontSize: 26, bold: true },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE"
        }
    };
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
            requests: [
                {
                    repeatCell: {
                        range: { sheetId, startRowIndex: rowIndex - 1, endRowIndex: rowIndex, startColumnIndex: 0, endColumnIndex: 1 },
                        cell: bigFormat,
                        fields: "userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)"
                    }
                },
                {
                    repeatCell: {
                        range: { sheetId, startRowIndex: rowIndex - 1, endRowIndex: rowIndex, startColumnIndex: 3, endColumnIndex: 4 },
                        cell: bigFormat,
                        fields: "userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)"
                    }
                },
                {
                    updateDimensionProperties: {
                        range: { sheetId, dimension: "ROWS", startIndex: rowIndex - 1, endIndex: rowIndex },
                        properties: { pixelSize: 46 },
                        fields: "pixelSize"
                    }
                }
            ]
        }
    });
}

async function appendGateScanRow({
    scannedAt, ticketCode, customerName, seats, showtimeId,
    outcome, checkedInCount, totalCount, message
}) {
    if (!SHEET_ID) return; // Chưa cấu hình GATE_SCAN_SHEET_ID — bỏ qua, không throw.

    const sheets = getSheetsClient();
    const title = tabTitleForDate(scannedAt);
    const sheetId = await ensureTabExists(sheets, title);

    const timeLabel = new Intl.DateTimeFormat("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(scannedAt);

    const appendRes = await sheets.spreadsheets.values.append({
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

    // updatedRange dạng "'Checkin 9/10'!A5:H5" — lấy số dòng vừa ghi để format
    // đúng dòng đó, không ảnh hưởng dòng khác.
    const rowMatch = appendRes.data.updates.updatedRange.match(/![A-Z]+(\d+):/);
    if (rowMatch) {
        await highlightRow(sheets, sheetId, parseInt(rowMatch[1], 10));
    }
}

module.exports = { appendGateScanRow };
