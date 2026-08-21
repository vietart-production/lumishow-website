const path = require("path");

require("dotenv").config({
    path: path.resolve(__dirname, "../../.env")
});

const {
    initializeApp,
    cert,
    getApps
} = require("firebase-admin/app");

const {
    getFirestore
} = require("firebase-admin/firestore");

// Cho phép đổi project Firebase (vd. sang project test) chỉ bằng cách đổi
// FIREBASE_SERVICE_ACCOUNT_FILE trong .env, không cần sửa code hay ghi đè
// file key gốc. Không set biến này thì mặc định dùng serviceAccountKey.json.
const serviceAccountFile =
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE || "serviceAccountKey.json";

const serviceAccountPath = path.resolve(
    __dirname,
    "../../",
    serviceAccountFile
);

const serviceAccount = require(serviceAccountPath);


// Chỉ khởi tạo Firebase nếu chưa được khởi tạo
if (getApps().length === 0) {
    initializeApp({
        credential: cert(serviceAccount)
    });
}

console.log(
    `[firebase] Đang dùng project: ${serviceAccount.project_id} (key: ${serviceAccountFile})`
);


// Kết nối Firestore
const db = getFirestore();

module.exports = {
    db
};