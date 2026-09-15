# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

LumiShow is a ticketing website for a Vietnamese circus show ("Sơn Thần Thủy Quái" at Rạp Xiếc Trung Ương). It has two independent parts that are developed and run separately:

- `frontend/` — static, framework-free HTML/CSS/JS pages, no build step.
- `backend/` — a Node/Express API backed by Firebase Firestore, handling seat inventory and holds.

There is no root-level package.json tying the two together; each half has its own tooling (or none).

## Commands

Backend (run from `backend/`):
```
npm install         # install dependencies
npm run dev          # start API server (node src/index.js, no watch/reload)
npm run start        # same as dev
npm run seed:seats   # seed one showtime's full seat map into Firestore (backend/scripts/seedSeats.js)
```
There is no lint or test script configured in `backend/package.json`.

Frontend: no build tooling. Pages are opened/served directly — the backend's CORS allowlist (`backend/src/index.js`) only permits origins `http://127.0.0.1:5500` and `http://localhost:5500`, so the frontend is expected to run via VS Code Live Server (or an equivalent static server on port 5500), not via `file://`.

The backend requires two local files that are gitignored and not present by default:
- `backend/.env` — at minimum `PORT`, `NODE_ENV`, `FRONTEND_URL`.
- `backend/serviceAccountKey.json` — a Firebase service account key, loaded by `backend/src/config/firebase.js`.

## Backend architecture

Entry point `backend/src/index.js` wires up Express: CORS (strict allowlist, see above), `express.json()`, mounts all API routes under `/api` from `booking.routes.js`, and exposes `GET /health` which pings Firestore.

Firestore data model (see `backend/src/services/booking.service.js` and `backend/scripts/seedSeats.js`):
- `shows/{showId}/showtimes/{showtimeId}/seats/{seatCode}` — one doc per seat, with `status` (`AVAILABLE` | `HELD` | `SOLD`), `holdId`, `holdExpiresAt`, `tier`, `price`, etc. `seatCode` is `{rowLetter}{number}` (e.g. `B12`).
- `holds/{holdId}` — top-level collection, `status` (`ACTIVE` | `EXPIRED`), `seatIds`, `expiresAt`, `bookingSessionId`.

Seat holding is transactional and lazily expired, not cron-driven:
- `createHold()` (booking.service.js) runs inside a single `db.runTransaction`: validates the showtime is `OPEN`, re-reads every requested seat to confirm it's still `AVAILABLE`, then atomically writes the hold doc and flips the seats to `HELD`.
- `cleanupExpiredHolds()` / `releaseExpiredHold()` walk `holds` where `status == ACTIVE && expiresAt <= now`, flip their seats back to `AVAILABLE`, and mark the hold `EXPIRED`. This is invoked at the top of both `getSeatStates()` and `createHold()` — there is no background job, expiry only happens as a side effect of the next read/write.
- Booking limits live in `backend/src/config/booking.config.js` (`MAX_SEATS_PER_ORDER`, `HOLD_DURATION_MS`, `MAX_ACTIVE_HOLDS_PER_SESSION`) — change limits there, not inline.

`backend/src/routes/payment.routes.js` and `backend/src/services/payment.service.js` currently exist but are empty — payment (via the `@payos/node` dependency, converting a hold into a `SOLD` seat) is not yet implemented. `helmet` and `express-rate-limit` are also dependencies not yet wired into `index.js`.

`backend/scripts/seedSeats.js` is the source of truth for the venue layout: it hardcodes `SHOW_ID`, `SHOWTIME_ID`, the row list (`ROWS`, each with a seat count), and the row→pricing-tier mapping (`NEAR_ROWS` → "Sơn Thần", `MID_ROWS` → "Thủy Quái", rest → "Mị Nương"). It requires `../src/config/firebase` directly (run as a standalone script, not through the Express app) and writes seats in batches of 400. Any change to row layout/tiers here must stay in sync with the seat map building logic in `frontend/BookingTicket.html`, since seat codes must match exactly.

## Frontend architecture

Each page in `frontend/` (`index.html`, `GioiThieu.html`, `LienHe.html`, `BookingTicket.html`) is fully self-contained — inline `<style>` and `<script>`, no shared JS/CSS modules, no framework or bundler.

`BookingTicket.html` is by far the largest page (~2300 lines) and does the real work of the app:
- It procedurally builds an interactive circular SVG seat map (rows B–P, odd/even sides mirrored) purely via `document.createElementNS` calls — no charting/SVG library.
- `API_BASE_URL` is hardcoded to `http://localhost:3000/api`; `fetchSeatStates()` calls `GET /api/shows/:showId/showtimes/:showtimeId/seats` and maps backend seat `status` values (`AVAILABLE`/`HELD`/`SOLD`) onto frontend seat-state constants. Update this URL when pointing at a non-local backend.
- Seat IDs used here must match the `{row}{number}` `seatCode` scheme produced by `backend/scripts/seedSeats.js`.

## Conventions

Comments, log messages, and user-facing strings throughout the codebase (both backend and frontend) are written in Vietnamese, consistent with the domain vocabulary already in use (e.g. `ghế` = seat, `giữ ghế` = hold seat, `suất diễn` = showtime, `hạng ghế` = seat tier). Match this when adding new code/comments in these files.

## Lỗ hổng bảo mật đã biết, HOÃN sửa (audit 2026-09-12)

Đã audit toàn diện 2026-09-12 và vá 16 lỗi (xem git log quanh commit `41eb4c0`: đối chiếu số tiền PayOS, giữ chỗ coupon atomic, chặn suất đã diễn, thực thi giới hạn hold/phiên, rate limiter, v.v.). Còn 3 hạng mục **hoãn có chủ đích** — nhắc lại khi muốn sửa:

- **C6 — không có đối soát đơn treo + webhook PayOS chưa đăng ký (QUAN TRỌNG NHẤT, khách có thể mất tiền thật):** vé chỉ được chốt bởi poll frontend (chỉ chạy khi tab đang mở) hoặc webhook — mà chưa nơi nào gọi `payos.webhooks.confirm()`. Khách chuyển khoản xong rồi đóng tab/mất mạng → đơn treo `PENDING_PAYMENT` mãi, khách mất tiền không có vé, không có mail cảnh báo. Ca khách "AN" ngày 2026-09-11 là nạn nhân thật (đã xử lý tay). Sửa: (1) Render Cron Job quét `orders` có `orderStatus == "PENDING_PAYMENT"` trong ~7 ngày, gọi `getPaymentStatus(orderId)` từng đơn để chốt nếu PayOS báo đã trả; (2) đăng ký webhook thật (endpoint `POST /api/payments/webhook` đã có sẵn và đã bỏ rate-limit, cần trả 200 cho payload test rồi confirm trên PayOS dashboard).

- **C1 + C7 — `firestore.rules` mở đọc/ghi `tickets` + thiếu logic check-in phía server (nguy cơ bị tấn công CHỦ ĐỘNG, đánh giá thấp nên hoãn):** `firestore.rules` hiện `allow read` + `allow update` collection `tickets` cho mọi client đã đăng nhập (Anonymous Auth). Firestore Rules cộng dồn kiểu OR nên khối `match /{document=**} { allow read,write: if false }` KHÔNG khoá được rule `tickets` bên dưới. Hệ quả: bất kỳ ai tạo anonymous token (web API key nằm trong APK app soát vé, decompile được) đều dump được toàn bộ PII khách và set `checkedIn=true` hàng loạt. **Chưa vá được bằng cách khoá rules** vì app soát vé Unity (`../SonThanThuyQuai_TicketManager`, file `FirebaseManager.cs`) đọc/ghi Firestore TRỰC TIẾP. Sửa đúng cần phối hợp cả 2 project: (1) thêm endpoint backend `POST /api/admin/tickets/checkin` (transaction: chỉ nhận vé `ticketStatus === "valid"` + `checkedIn === false` + đúng suất đang diễn hôm nay); (2) sửa app Unity gọi endpoint đó thay vì đọc/ghi Firestore; (3) build lại APK; (4) khoá `firestore.rules` về `if false` toàn bộ. C7 (chống quét trùng / kiểm suất / kiểm ticketStatus phía server) được giải quyết cùng lúc.

- **C5 — ĐÃ XỬ LÝ (2026-09-12):** `ADMIN_PIN` đã được set trên Render. Fallback `"0410205"` trong `admin.service.js` giờ chỉ là dự phòng; cân nhắc bỏ hẳn (fail-fast khi thiếu env) khi đã chắc env luôn có.

## Tạm khoá bán vé các suất sau tháng 9 (2026-09-14)

Chưa chốt lịch diễn tháng 10-12 nên tạm dừng bán vé các suất sau 27.09.2026, chỉ mở 3 suất cuối tuần 25-27.09. Gồm 2 phần, phải sửa đồng bộ cả hai khi mở/khoá lại:

1. **Firestore** — 65 doc `shows/son-than-thuy-quai/showtimes/{showtimeId}` từ `2026-10-01` trở đi đã đổi `status: "OPEN"` → `"CLOSED"`. `createHold()` (booking.service.js) chặn giữ ghế khi `status !== "OPEN"`, nên đây là lớp chặn thật ở tầng server.
2. **Frontend** — lịch hiển thị ở `frontend/index.html` (widget "Lịch diễn sắp tới" trang chủ) và `frontend/dat-ve.html` (trang đặt vé) mỗi bên tự vẽ calendar theo `SEASON_START`/`SEASON_END` hardcode riêng, KHÔNG hỏi Firestore — sửa 1 bên mà quên bên kia thì khách vẫn chọn được ngày đã khoá (chỉ bị chặn âm thầm ở bước giữ ghế). Cả hai đã chỉnh `SEASON_END` về `2026-08-30`(tức hết tháng 9) để khớp với Firestore.

Khi có lịch tháng 10-12 chính thức: đổi `status` các showtime muốn mở lại về `"OPEN"`, rồi nới `SEASON_END` ở **cả hai** file frontend cho khớp — thiếu 1 trong 2 bước sẽ tái diễn tình trạng "đặt được nhưng thật ra không mở".

## Trang tra cứu đơn hàng cho đối tác (2026-09-15)

Đối tác nghiệp vụ (kế toán/venue) cần xem đơn/vé thật để đối soát — thêm `frontend/partner-orders.html` (không gắn nav) gọi `POST /api/partner/orders/list` (`backend/src/routes/partner.routes.js` + `partner.service.js`), lọc theo `showtimeId`/`orderStatus`, phân trang cursor.

Bảo vệ bằng `PARTNER_API_KEY` — **key riêng, tách hẳn khỏi `ADMIN_PIN`** (PIN đó huỷ/tạo được vé thật; key này chỉ đọc, không có endpoint ghi tương ứng). Không có fallback mặc định như `ADMIN_PIN` — thiếu env thì fail-closed (`checkPartnerKey()` luôn `false`), không vô tình chạy production với key rỗng.

**Phải set `PARTNER_API_KEY` trên Render thì endpoint mới hoạt động** — đã có trong `backend/.env` local, chưa tự đẩy lên Render được (không có quyền truy cập dashboard). Gửi đối tác: link trang + giá trị key (qua kênh riêng, không nhắn chung với link).

4 composite index mới cho collection `orders` trong `firestore.indexes.json` (đã deploy) — cần cả 4 vì Firestore yêu cầu index khớp đúng tổ hợp field lọc (`showId` luôn có, cộng thêm `showtimeId`/`orderStatus` tuỳ chọn) + `orderBy(createdAt)`.
