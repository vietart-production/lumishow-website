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

## Khóa 1 phần ghế (không phải đóng cả suất) — trạng thái ghế `BLOCKED` (2026-09-16)

3 suất diễn cuối tháng 9 (`2026-09-25_20:00`, `2026-09-26_16:30`, `2026-09-27_10:00`) cần khóa bớt 1 phần ghế (toàn bộ bên lẻ + 1 số range bên chẵn theo yêu cầu venue) — **không dùng `status:"SOLD"`** vì ghế khóa không phải ghế bán thật, để `SOLD` sẽ làm sai lệch mọi thống kê/đối soát doanh thu sau này (partner-orders, báo cáo...). Thêm hẳn giá trị `status` thứ 4: **`BLOCKED`**, song song với `AVAILABLE`/`HELD`/`SOLD` đã có (xem `CLAUDE.md` mục "Backend architecture" gốc).

Đã sửa đồng bộ ở `frontend/dat-ve.html` (sơ đồ ghế) — nếu sau này còn nơi khác đọc seat status thì phải rà lại tương tự:
- `ST.BLOCKED` thêm vào state machine, map từ `serverSeat.status === "BLOCKED"` trong `fetchSeatStates()`.
- Tái dùng CSS `st-sold` (nhìn giống ghế đã bán — khách không cần biết lý do, chỉ cần biết không chọn được), nhưng thông báo riêng `msg.seatBlocked`/`seat.blocked` ("tạm khóa", không nói "đã bán") ở toast, seat-card, và guard trong `addSeat()`/`handleSeatTap()` — để không nói sai sự thật với khách.
- Backend `booking.service.js` không cần sửa: `createHold()` vốn đã allow-list `status !== "AVAILABLE"` nên `BLOCKED` tự động bị chặn giữ ghế, thông báo lỗi sẵn có ("không còn trống") vẫn đúng.

## Đổi hạng ghế: phía trước hàng O, P từ Thủy Quái → Mị Nương (2026-09-16)

Theo yêu cầu venue: khu vực phía trước (đối diện sân khấu, `y > CY`) của 2 hàng ngoài cùng **O, P** không còn tính hạng "Thủy Quái" (250k) như K,L,M,N nữa — đổi thành "Mị Nương" (200k), tức khớp với phần phía sau (vốn đã luôn là Mị Nương). Tính theo tọa độ thật (`SEAT_XY`), không phải theo khoảng số ghế — kết quả: **O1-O48 (47 ghế)** và **P1-P42 (42 ghế)** đổi hạng, tổng 89 mã ghế/suất diễn.

Sửa đồng bộ ở 3 nơi (thiếu 1 trong 3 sẽ lệch giá client/server):
- `frontend/dat-ve.html`: `OUTER_ROWS` (hàm `tierOf()`) bỏ O,P — đây là nơi **quyết định giá thật sự khách bị tính tiền khi đặt vé** (client tự tính giá từ `SEAT_XY`, không đọc `price` từ backend — endpoint `/seats` chỉ trả `status`).
- `backend/scripts/seatTiers.generate.js`: sửa luôn path cũ trỏ `BookingTicket.html` (file không còn tồn tại, đã đổi tên thành `dat-ve.html` từ trước) + bỏ O,P khỏi `OUTER_ROWS`, chạy `node scripts/seatTiers.generate.js` để sinh lại `seatTiers.json` (nguồn seed cho suất diễn mới).
- Firestore: đã chạy migration 1 lần cho **6052 ghế** (89 mã × 68 suất diễn hiện có, kể cả suất tháng 10-12 đang `CLOSED`) — set `tier:"mi-nuong", tierName:"Mị Nương", price:200000`, bỏ qua ghế `SOLD`/`HELD` (không có ghế nào trong vùng O/P-front đã bán hoặc đang giữ tại thời điểm đổi, nên không có ngoại lệ nào bị bỏ qua thật). Suất diễn tạo mới sau này tự động seed đúng nhờ `seatTiers.json` đã sửa.

## Thử nâng hạng "nửa khu ghế phía sau đổ về phía thoát hiểm" lên Thủy Quái — ĐÃ REVERT (2026-09-16)

Đã thử áp dụng: 10 hàng B,C,D,E,G,H,I,K,L,M, range `K74-116, M108-130, L106-128, I72-86, H96-108, G90-106, E82-98, D72-88, C64-78, B54-64` (188 mã/suất) nâng từ Mị Nương lên Thủy Quái. User phản hồi **"ngược side rồi"** — sau 2 vòng hỏi lại vẫn chưa xác định được chính xác ý user muốn range/hướng nào, nên user chốt: **bỏ hẳn, revert toàn bộ khu vực phía sau về lại Mị Nương như cũ**.

Đã revert đầy đủ: bỏ `EXIT_SIDE_UPGRADE` khỏi `tierOf()` ở `frontend/dat-ve.html` và khỏi `backend/scripts/seatTiers.generate.js`, chạy lại generate (seatTiers.json về đúng phân bố như sau khi đổi O,P: son-than 335 / thuy-quai 187 / mi-nuong 653), và migrate Firestore trả 12784 ghế (188 mã × 68 suất) về `tier:"mi-nuong", price:200000`.

**Lưu ý nếu làm lại sau này:** user có nhắc tới "K73-" (câu bị cắt ngang, chưa rõ ý đầy đủ) — có thể liên quan tới việc range nên bắt đầu từ K73 thay vì K74, hoặc ý khác chưa nói hết. Nên hỏi lại rõ trước khi động vào vùng này lần nữa, và ưu tiên xin ảnh chụp khoanh vùng trực tiếp trên sơ đồ thật (cách đã hiệu quả ở các lần trước) thay vì suy đoán hướng trong/ngoài.

Danh sách range bên chẵn đã khóa (cộng thêm bên lẻ toàn bộ mọi hàng): K74-116, O72-92, N74-96, M108-130, L106-128, I72-86, H96-108, G90-106, E82-98, D72-88, C64-78, B54-64, **P74-96** (P bị sót ở đợt khóa đầu 2026-09-16, bổ sung cùng ngày sau khi user phát hiện).

**Cập nhật 2026-09-16 (sau đó cùng ngày):** K74-94 mở lại toàn bộ rồi user chỉnh lại chính xác hơn: **chỉ bên chẵn K74-94 mới AVAILABLE, bên lẻ K73-93 khóa lại (BLOCKED)** — tức quay về đúng logic gốc "bên lẻ toàn bộ khóa". Trạng thái hiện tại của vùng K73-96: K73 (lẻ, luôn BLOCKED từ đầu), K75-93 lẻ (BLOCKED, khóa lại 2026-09-16), K74-94 chẵn (AVAILABLE), K95-96 (BLOCKED, chưa ai yêu cầu mở). Riêng K97-116 vẫn BLOCKED nguyên như đợt khóa gốc.

Không có endpoint admin để khóa/mở ghế theo batch — làm bằng script Node tạm thời (`backend/scripts/tmp_*.js`, xoá ngay sau khi chạy, theo đúng quy ước) đọc `backend/scripts/seatTiers.json` làm nguồn sự thật cho mã ghế thật của từng hàng (min/max KHÔNG đủ, có nhiều lỗ hổng số ghế do kiến trúc lối thoát hiểm/WC — ví dụ hàng K thiếu 45,47,49-72; phải kiểm tra tồn tại từng mã, không suy ra từ khoảng số). Script bỏ qua (không đụng) ghế đã `SOLD` thật; ghế đang `HELD` thì cũng bỏ qua + cảnh báo để xử lý tay, không ép chuyển như cách `blockStaffSeats.js` làm với ghế staff (khối lượng đợt này lớn hơn nhiều, suất đang mở bán thật, không nên tự ý cướp hold của khách đang thanh toán dở).

Muốn mở lại các ghế này: chạy script tương tự đổi `BLOCKED` → `AVAILABLE` cho đúng danh sách mã ghế đã khóa (không có cách tự động phân biệt "từng bị BLOCKED" sau khi đã đổi, nên giữ lại danh sách mã ghế nếu cần mở lại sau).

## Trang tra cứu đơn hàng cho đối tác (2026-09-15)

Đối tác nghiệp vụ (kế toán/venue) cần xem đơn/vé thật để đối soát — thêm `frontend/partner-orders.html` (không gắn nav) gọi `POST /api/partner/orders/list` (`backend/src/routes/partner.routes.js` + `partner.service.js`), lọc theo `showtimeId`/`orderStatus`, phân trang cursor.

Bảo vệ bằng `PARTNER_API_KEY` — **key riêng, tách hẳn khỏi `ADMIN_PIN`** (PIN đó huỷ/tạo được vé thật; key này chỉ đọc, không có endpoint ghi tương ứng). Không có fallback mặc định như `ADMIN_PIN` — thiếu env thì fail-closed (`checkPartnerKey()` luôn `false`), không vô tình chạy production với key rỗng.

**Phải set `PARTNER_API_KEY` trên Render thì endpoint mới hoạt động** — đã có trong `backend/.env` local, chưa tự đẩy lên Render được (không có quyền truy cập dashboard). Gửi đối tác: link trang + giá trị key (qua kênh riêng, không nhắn chung với link).

4 composite index mới cho collection `orders` trong `firestore.indexes.json` (đã deploy) — cần cả 4 vì Firestore yêu cầu index khớp đúng tổ hợp field lọc (`showId` luôn có, cộng thêm `showtimeId`/`orderStatus` tuỳ chọn) + `orderBy(createdAt)`.

**Công cụ Admin trên cùng trang (2026-09-16):** nút "🔒 Công cụ Admin" trên `partner-orders.html` mở khoá bằng **`ADMIN_PIN`** (PIN huỷ/tạo vé sẵn có, KHÔNG phải `PARTNER_API_KEY`) — gọi `POST /api/admin/verify-pin` để xác nhận trước khi vẽ thêm cột "Thao tác" (Sửa/Xoá) trên từng dòng. Sửa gọi `POST /api/admin/orders/update`, xoá gọi `POST /api/admin/orders/delete` (`deleteOrder()`/`updateOrderCustomerInfo()` trong `admin.service.js`) — cả hai đều dùng `requirePin` + `adminLimiter` có sẵn trong `admin.routes.js`, không phải endpoint mới tách riêng rate-limit. Xoá là xoá hẳn (order + ticket liên quan, trả ghế về AVAILABLE) — không hoàn tác được, khác với `cancelTicketBySeat()` (giữ dấu vết `ticketStatus="cancelled"`).

Trang cũng có nút "Tải Excel (.xlsx)" — xuất file `.xlsx` thật (dùng thư viện SheetJS qua CDN `cdnjs.cloudflare.com/ajax/libs/xlsx`, không cần build tool) từ đúng danh sách `lastLoadedOrders` đang hiển thị sau khi lọc: header in đậm, đóng băng hàng đầu, autofilter, độ rộng cột tự tính theo nội dung dài nhất (min 10/max 45 ký tự), cột "Tiền" định dạng số có dấu phẩy ngăn nghìn (`#,##0`) thay vì chuỗi text (2026-09-16, thay cho bản CSV trước đó vì Excel hiển thị CSV xấu/cột hẹp).
