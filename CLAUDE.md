# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

LumiShow is a ticketing website for a Vietnamese circus show ("Sơn Thần Thủy Quái" at Rạp Xiếc Trung Ương). It has two independent parts that are developed and deployed separately:

- `frontend/` — static, framework-free HTML/CSS/JS pages, no build step. Deployed as-is to Firebase Hosting (project `sonthanthuyquai-ticket`, see `firebase.json`/`.firebaserc`).
- `backend/` — a Node/Express API backed by Firebase Firestore, handling seat inventory/holds, PayOS payments, ticket emails/QR, and a couple of PIN/API-key-gated ops endpoints (manual ticketing, partner order reconciliation). Deployed to Render; production URL is `https://lumishow-website.onrender.com` (hardcoded as `API_BASE_URL` in the frontend pages that call it).

There is no root-level package.json tying the two together; each half has its own tooling (or none). There's also a separate Unity app (`../SonThanThuyQuai_TicketManager`, outside this repo) used at the venue gate that talks to this backend's `/api/admin/*` endpoints and reads/writes Firestore `tickets` directly for check-in — see the `firestore.rules` note and the security-audit section below.

## Commands

Backend (run from `backend/`):
```
npm install          # install dependencies
npm run dev           # start API server (node src/index.js, no watch/reload)
npm run start          # same as dev
npm run seed:seats     # seed one showtime's full seat map into Firestore (backend/scripts/seedSeats.js)
npm run seed:season    # same script as seed:seats (alias)
npm run coupons        # backend/scripts/manageCoupons.js — create/inspect/deactivate discount coupons
```
There is no lint or test script configured in `backend/package.json`. A handful of other one-off scripts are run directly with `node` (not wired into `package.json`) and are the standard way to do bulk/manual Firestore edits — see `backend/scripts/`:
- `seatTiers.generate.js` — regenerates `backend/scripts/seatTiers.json`, the generated source-of-truth mapping every seat code to its pricing tier (used both by `seedSeats.js` when seeding new showtimes and, conceptually, mirrored by `tierOf()` in `frontend/dat-ve.html`). Never hand-edit `seatTiers.json`; edit the tier logic in this script and regenerate.
- `blockStaffSeats.js`, `removeRetiredSeats.js` — batch seat-status maintenance scripts.
- `reconcilePendingOrders.js` — manual/CLI entry point for the same reconciliation logic that also runs on a timer inside `index.js` (pass `--commit` to actually write; without it, it's a dry run).
- One-off `tmp_*.js` scripts get written for ad-hoc bulk seat edits (e.g. blocking/unblocking a range) and deleted right after running — see the seat-tier/blocking history further down this file for the established pattern (always resolve real seat codes from `seatTiers.json`, never assume a contiguous numeric range exists; skip `SOLD`/`HELD` seats rather than overwriting them).

Frontend: no build tooling, two ways to run it:
- **Local dev**: open pages via VS Code Live Server (or an equivalent static server on port 5500), not `file://`. The backend's CORS allowlist (`backend/src/index.js`) only opens `http://127.0.0.1:5500`/`http://localhost:5500` when `NODE_ENV !== "production"`. Every page's `API_BASE_URL` is hardcoded to the production Render URL by default — edit it locally (e.g. to `http://localhost:3000/api`) to point at a local backend instead.
- **Deploy**: `firebase deploy --only hosting` publishes `frontend/` verbatim (`firebase.json`: `cleanUrls: true`, plus 301 redirects from the old PascalCase filenames — `GioiThieu.html`→`/gioi-thieu`, `LienHe.html`→`/lien-he`, `BookingTicket.html`→`/dat-ve` — to the current kebab-case ones). `firebase deploy --only firestore:rules,firestore:indexes` deploys `firestore.rules`/`firestore.indexes.json` separately.

The backend requires local files that are gitignored and not present by default:
- `backend/.env` — `PORT`, `NODE_ENV`, `FRONTEND_URL`, `ADMIN_PIN`, `PARTNER_API_KEY`, `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `CONTACT_TO_EMAIL`, `ORDER_NOTIFY_EMAIL`, `TECH_ALERT_EMAIL`, `RENDER_EXTERNAL_URL` (used to build absolute QR/email links; see local-ops memory note about it being missing locally).
- `backend/serviceAccountKey.json` — a Firebase service account key, loaded by `backend/src/config/firebase.js` (or point `FIREBASE_SERVICE_ACCOUNT_FILE` at a different file, e.g. for a second/test project).

## Backend architecture

Entry point `backend/src/index.js` wires up Express: `helmet()`, `trust proxy` (1 hop, for Render), a global `apiLimiter` (60 req/min/IP on all of `/api`, explicitly skipping `/api/payments/webhook` so PayOS bursts don't get 429'd), a strict CORS allowlist (`lumishow.vn`, `www.lumishow.vn`, `sonthanthuyquai-ticket.web.app`, plus the two `:5500` localhost origins outside production), `express.json()`, then mounts seven route modules under `/api`, a static `GET /health` (no Firestore ping — a prior version pinged Firestore per call and got rate-limited), and a final JSON error handler that never leaks stack traces. At the bottom, a `setInterval` runs `reconcilePendingOrders({ commit: true })` every 10 minutes as a standing safety net (see the "C6" note further down — the PayOS webhook isn't registered yet).

Route module → service module map (each route file also carries its own `express-rate-limit` instance sized to how sensitive/expensive the endpoint is — e.g. `adminLimiter` and `couponLimiter` are much stricter than the general `apiLimiter`):
- `booking.routes.js` → `booking.service.js` — seat states, hold create/status.
- `payment.routes.js` → `payment.service.js` — PayOS order creation, webhook handler, status polling.
- `ticket.routes.js` — `GET /api/tickets/:ticketCode/qr.png`, generates a QR PNG on the fly via the `qrcode` package (nothing stored/looked up); used instead of an embedded base64 image because mail clients strip those.
- `contact.routes.js` → `email.service.js` — contact form → Resend email.
- `admin.routes.js` → `admin.service.js` — `ADMIN_PIN`-gated (`requirePin` middleware): manual ticket create/cancel, showtime listing, order update/delete. Used by both the venue's Unity gate app and the admin tools on `frontend/partner-orders.html`.
- `coupon.routes.js` → `coupon.service.js` — coupon validate (display-only, doesn't consume a use); the real atomic reserve/release happens inside `payment.service.js` at order-creation time.
- `partner.routes.js` → `partner.service.js` — `PARTNER_API_KEY`-gated, read-only order listing with cursor pagination, for accounting/venue reconciliation.

Firestore data model:
- `shows/{showId}/showtimes/{showtimeId}` — has a `status` (`OPEN` | `CLOSED`); `createHold()` refuses to hold seats on a non-`OPEN` showtime.
- `shows/{showId}/showtimes/{showtimeId}/seats/{seatCode}` — one doc per seat: `status` (`AVAILABLE` | `HELD` | `SOLD` | `BLOCKED`), `holdId`, `holdExpiresAt`, `tier`, `tierName`, `price`. `seatCode` is `{rowLetter}{number}` (e.g. `B12`). `BLOCKED` is a manually-set fourth status for seats withheld from sale (venue holdbacks) without misrepresenting them as `SOLD` in revenue reports.
- `holds/{holdId}` — top-level collection, `status` (`ACTIVE` | `EXPIRED`), `seatIds`, `expiresAt`, `bookingSessionId`.
- `orders/{orderId}` — one per checkout attempt: `orderStatus` (`PENDING_PAYMENT` | `PAID` | `CANCELLED` | `EXPIRED`), `paymentStatus`, `holdId`, customer contact info, coupon code, amount.
- `tickets/{ticketId}` — created once an order is confirmed `PAID` (one per seat): `orderId`, `ticketCode`, `ticketStatus` (`valid` | `cancelled` | `conflict_needs_review`), `checkedIn`/`checkedInAt`. These last two are the only fields the Unity gate app can write directly (see `firestore.rules`, and the C1/C7 note below for why that's still a known gap).
- `coupons/{code}` — `percentOff`, `usedCount`, etc.

Seat holding is transactional and lazily expired, not cron-driven:
- `createHold()` (`booking.service.js`) runs inside a single `db.runTransaction`: validates the showtime is `OPEN`, re-reads every requested seat to confirm it's still `AVAILABLE`, then atomically writes the hold doc and flips the seats to `HELD`.
- `cleanupExpiredHolds()` / `releaseExpiredHold()` walk `holds` where `status == ACTIVE && expiresAt <= now`, flip their seats back to `AVAILABLE`, and mark the hold `EXPIRED`. This is invoked at the top of both `getSeatStates()` and `createHold()` — there is no background job, expiry only happens as a side effect of the next read/write.
- Booking limits live in `backend/src/config/booking.config.js` (`MAX_SEATS_PER_ORDER`, `HOLD_DURATION_MS`, `MAX_ACTIVE_HOLDS_PER_SESSION`) — change limits there, not inline.

Payment/pricing money flow, all server-truth: `createPaymentForHold()` (`payment.service.js`) re-reads the real Firestore `price` for every held seat (never trusts a client-submitted amount) and, if a coupon code is present, re-validates and re-reserves it from scratch (the earlier `/api/coupons/validate` call was display-only). The PayOS webhook handler (`handlePaymentWebhook`) is idempotent on `orderStatus`, flips seats `HELD → SOLD` and the order to `PAID` inside a transaction, then creates one `tickets` doc per seat and emails them out. Note the frontend's own `tierOf()` pricing logic in `dat-ve.html` is only for pre-hold display — `GET /api/.../seats` never returns `price`, so the charge is always computed here from Firestore, not from anything the client sent.

`backend/scripts/seedSeats.js` is the source of truth for the venue layout when seeding a *new* showtime: it hardcodes `SHOW_ID`, `SHOWTIME_ID`, the row list (`ROWS`, each with a seat count), and reads per-seat tiers from `seatTiers.json` (generated by `seatTiers.generate.js`, see Commands above). It requires `../src/config/firebase` directly (run as a standalone script, not through the Express app) and writes seats in batches of 400. Any change to row layout/tiers must stay in sync with the seat-map building/pricing logic in `frontend/dat-ve.html`, since seat codes and tier boundaries must match exactly — see the seat-tier change history further down this file for how that's been done in practice.

## Frontend architecture

`frontend/` (`index.html`, `gioi-thieu.html`, `lien-he.html`, `dat-ve.html`, `partner-orders.html`, `404.html`) — each page is fully self-contained: inline `<style>` and `<script>`, no shared JS/CSS modules, no framework or bundler. Filenames are kebab-case matching the Firebase Hosting clean URLs (the old PascalCase names 301-redirect, see Commands above). `partner-orders.html` isn't linked from site nav — it's an internal ops tool for partner order lookup plus (behind a second, `ADMIN_PIN`-gated unlock) admin edit/delete tools, see the dedicated section on it further down this file.

`dat-ve.html` is by far the largest page (~3300 lines) and does the real work of the app:
- It procedurally builds an interactive circular SVG seat map (rows B–P, odd/even sides mirrored) purely via `document.createElementNS` calls — no charting/SVG library.
- `tierOf()` computes each seat's price tier/color client-side from hardcoded row/coordinate rules that must mirror `backend/scripts/seatTiers.generate.js` exactly (see the several seat-tier change entries further down this file for the established process, including the `TEST_MODE` flag used to visually QA tier changes against Live Server without touching production Firestore).
- `API_BASE_URL` is hardcoded to the production Render URL; `fetchSeatStates()` calls `GET /api/shows/:showId/showtimes/:showtimeId/seats` and maps backend seat `status` values (`AVAILABLE`/`HELD`/`SOLD`/`BLOCKED`) onto frontend seat-state constants. Update this URL locally when pointing at a non-production backend.
- Seat IDs used here must match the `{row}{number}` `seatCode` scheme produced by `backend/scripts/seedSeats.js`.
- Only 3 showtimes' calendars are currently open for booking (see the season-closure section further down this file) — `SEASON_START`/`SEASON_END` here and in `index.html` are hardcoded and don't query Firestore, so they must be kept in sync with each showtime's Firestore `status` by hand.

## Conventions

Comments, log messages, and user-facing strings throughout the codebase (both backend and frontend) are written in Vietnamese, consistent with the domain vocabulary already in use (e.g. `ghế` = seat, `giữ ghế` = hold seat, `suất diễn` = showtime, `hạng ghế` = seat tier). Match this when adding new code/comments in these files.

There's no automated test suite — changes to seat/pricing logic are verified with disposable `backend/scripts/tmp_*.js` scripts (deleted right after running) and, on the frontend, manual walkthroughs via Live Server with `dat-ve.html`'s `TEST_MODE` flag flipped on locally (never committed on) before a change goes live. See the dated history sections below for the concrete precedent each time this codebase's pricing, seat-blocking, season, or security posture has changed — they carry context (what was tried, reverted, and why) that isn't recoverable from the code alone.

## Lỗ hổng bảo mật đã biết, HOÃN sửa (audit 2026-09-12)

Đã audit toàn diện 2026-09-12 và vá 16 lỗi (xem git log quanh commit `41eb4c0`: đối chiếu số tiền PayOS, giữ chỗ coupon atomic, chặn suất đã diễn, thực thi giới hạn hold/phiên, rate limiter, v.v.). Còn 3 hạng mục **hoãn có chủ đích** — nhắc lại khi muốn sửa:

- **C6 — MỘT NỬA ĐÃ VÁ (2026-09-16), webhook PayOS vẫn CHƯA đăng ký:** `backend/src/services/reconcile.service.js` (`reconcilePendingOrders()`) quét mọi `orders` có `orderStatus == "PENDING_PAYMENT"`, hỏi thẳng PayOS từng đơn. `backend/src/index.js` chạy hàm này mỗi 10 phút nền (`commit:true`) khi instance còn thức — tự chốt vé (đã trả tiền nhưng khách đóng tab trước khi poll xác nhận) VÀ tự chuyển `orderStatus -> "EXPIRED"` nếu PayOS xác nhận chưa trả và đơn đã quá `EXPIRE_AFTER_MS` (60 phút). Ca khách "AN" ngày 2026-09-11 (đơn gốc treo `order_73f45941...`) và 5 đơn treo khác (cũ nhất >5 ngày) đã được dọn thủ công 2026-09-16 bằng `node scripts/reconcilePendingOrders.js --commit`.

  **Vẫn còn hở:** Render free có thể ngủ đông khi vắng traffic — lúc đó vòng lặp 10 phút không chạy, đơn treo phải chờ tới lần instance thức dậy tiếp theo mới được đối soát (không phải real-time, nhưng không còn "treo vĩnh viễn" như trước). Đăng ký webhook thật vẫn là cách đúng để tức thời — endpoint `POST /api/payments/webhook` đã có sẵn và đã bỏ rate-limit, cần trả 200 cho payload test rồi confirm trên PayOS dashboard (cần quyền truy cập dashboard PayOS, chưa tự làm được).

- **C1 + C7 — `firestore.rules` mở đọc/ghi `tickets` + thiếu logic check-in phía server (nguy cơ bị tấn công CHỦ ĐỘNG, đánh giá thấp nên hoãn):** `firestore.rules` hiện `allow read` + `allow update` collection `tickets` cho mọi client đã đăng nhập (Anonymous Auth). Firestore Rules cộng dồn kiểu OR nên khối `match /{document=**} { allow read,write: if false }` KHÔNG khoá được rule `tickets` bên dưới. Hệ quả: bất kỳ ai tạo anonymous token (web API key nằm trong APK app soát vé, decompile được) đều dump được toàn bộ PII khách và set `checkedIn=true` hàng loạt. **Chưa vá được bằng cách khoá rules** vì app soát vé Unity (`../SonThanThuyQuai_TicketManager`, file `FirebaseManager.cs`) đọc/ghi Firestore TRỰC TIẾP. Sửa đúng cần phối hợp cả 2 project: (1) thêm endpoint backend `POST /api/admin/tickets/checkin` (transaction: chỉ nhận vé `ticketStatus === "valid"` + `checkedIn === false` + đúng suất đang diễn hôm nay); (2) sửa app Unity gọi endpoint đó thay vì đọc/ghi Firestore; (3) build lại APK; (4) khoá `firestore.rules` về `if false` toàn bộ. C7 (chống quét trùng / kiểm suất / kiểm ticketStatus phía server) được giải quyết cùng lúc.

- **C5 — ĐÃ XỬ LÝ (2026-09-12):** `ADMIN_PIN` đã được set trên Render. Fallback `"0410205"` trong `admin.service.js` giờ chỉ là dự phòng; cân nhắc bỏ hẳn (fail-fast khi thiếu env) khi đã chắc env luôn có.

## Tạm khoá bán vé các suất sau tháng 9 (2026-09-14)

Chưa chốt lịch diễn tháng 10-12 nên tạm dừng bán vé các suất sau 27.09.2026, chỉ mở 3 suất cuối tuần 25-27.09. Gồm 2 phần, phải sửa đồng bộ cả hai khi mở/khoá lại:

1. **Firestore** — 65 doc `shows/son-than-thuy-quai/showtimes/{showtimeId}` từ `2026-10-01` trở đi đã đổi `status: "OPEN"` → `"CLOSED"`. `createHold()` (booking.service.js) chặn giữ ghế khi `status !== "OPEN"`, nên đây là lớp chặn thật ở tầng server.
2. **Frontend** — lịch hiển thị ở `frontend/index.html` (widget "Lịch diễn sắp tới" trang chủ) và `frontend/dat-ve.html` (trang đặt vé) mỗi bên tự vẽ calendar theo `SEASON_START`/`SEASON_END` hardcode riêng, KHÔNG hỏi Firestore — sửa 1 bên mà quên bên kia thì khách vẫn chọn được ngày đã khoá (chỉ bị chặn âm thầm ở bước giữ ghế). Cả hai đã chỉnh `SEASON_END` về `2026-08-30`(tức hết tháng 9) để khớp với Firestore.

Khi có lịch tháng 10-12 chính thức: đổi `status` các showtime muốn mở lại về `"OPEN"`, rồi nới `SEASON_END` ở **cả hai** file frontend cho khớp — thiếu 1 trong 2 bước sẽ tái diễn tình trạng "đặt được nhưng thật ra không mở".

## Mở lịch diễn tháng 10/2026 (2026-09-25)

Đã mở bán thật 23 suất diễn tháng 10 (5 cuối tuần: 2-4/10, 9-11/10, 16-18/10, 23-25/10, 30-31/10), theo đúng 2 lớp ở mục "Tạm khoá bán vé..." phía trên:

1. **Firestore** — cả 23 doc `shows/son-than-thuy-quai/showtimes/{showtimeId}` tháng 10 đổi `status: "CLOSED"` → `"OPEN"` (script tạm `backend/scripts/tmp_openOctober.js`, xoá ngay sau khi chạy theo đúng quy ước — không có endpoint admin bulk cho việc này).
2. **Frontend** — `SEASON_END` ở cả `frontend/index.html` và `frontend/dat-ve.html` nới `2026-08-30` → `2026-10-31`. `OPEN_TIMES_BY_DATE` (chỉ có ở `index.html`, quyết định khung giờ hiển thị trên widget lịch trang chủ) bổ sung đủ 17 ngày tháng 10.

Tháng 11-12 vẫn `CLOSED`, chưa đụng — theo yêu cầu user, mở **từng tháng một trong các bước/phiên làm việc riêng**, không gộp nhiều tháng cùng lúc khi làm tiếp sau này.

**Quy trình nên lặp lại cho các lần mở tháng/suất sau:**
- Trước khi ghi Firestore, LUÔN xác minh script đang trỏ đúng project thật (đối chiếu 1 sự thật đã biết chắc trong Firestore — ví dụ số đơn/vé thật đã ghi lại ở CLAUDE.md, như 218 đơn "Rạp Xiếc Customer" ở mục "Bán buôn toàn bộ ghế Thủy Quái..." — KHÔNG tin suông biến `FIREBASE_SERVICE_ACCOUNT_FILE` trong `.env` local, vì từng có lúc bị trỏ tạm sang project test).
- `SEASON_END` dựng lịch theo **khối tuần** (Thứ 6+7+CN liền nhau, xem hàm `runs` ở cả 2 file frontend) chứ không theo từng suất lẻ — nới `SEASON_END` sẽ lộ nguyên cả cuối tuần đó trên lịch, dù Firestore có thể chưa `OPEN` hết các suất trong cuối tuần đó. Nên chỉ nới `SEASON_END` đến đúng ranh giới đã thật sự mở hết ở Firestore, không nới trước để tránh lộ suất chưa sẵn sàng.
- **Quy tắc rollout cho các thay đổi ghế/giá của tháng 10 (2026-09-26, user chốt):** bất kỳ sửa đổi nào lên dữ liệu ghế tháng 10 (đổi hạng/giá, khoá/mở range...) chỉ áp dụng thử lên **1 suất mốc `2026-10-02_*`** trước — KHÔNG áp cả tháng ngay. Đợi user xem/chốt "ok" trên suất mốc đó rồi mới lặp lại đúng thay đổi cho toàn bộ 23 suất tháng 10 còn lại. Áp dụng cho các phiên làm việc sau này khi có yêu cầu sửa sơ đồ ghế tháng 10.

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

## Nâng hạng Thủy Quái cho dải ghế phía sau theo sơ đồ venue gửi trực tiếp — THÀNH CÔNG (2026-09-16, sau lần revert ở trên)

User gửi 2 ảnh chụp trực tiếp sơ đồ ghế thật venue (10 hàng B,C,D,E,G,H,I,K,L,M, 1 ảnh số chẵn + 1 ảnh số lẻ = 1 dải liên tục mỗi hàng) thay vì mô tả bằng lời — đây mới là "range đúng" (khác hẳn range đã revert ở trên). Đọc ảnh, tự động lọc bỏ (1) mã ghế không tồn tại thật và (2) ghế lỡ rơi vào phía trước (không thuộc "khu vực phía sau") trước khi ghi, để tránh đọc sai vài số biên trên ảnh chữ nhỏ/chéo làm hỏng dữ liệu giá:

`B35-52, C39-62, D43-70, E47-80, G51-88, H55-94, I59-70, K73-94, L79-104, M83-106` — sau khi lọc còn **237 mã ghế thật/suất diễn** (đã loại vài chục mã rơi vào phía trước ở đầu dải C,D,E,G,H, và vài mã không tồn tại ở K/L/M do khoảng trống kiến trúc thật).

Kỹ thuật giống hệt 2 lần đổi hạng trước: thêm `EXIT_SIDE_UPGRADE` (map hàng→[min,max]) vào `tierOf()` ở `frontend/dat-ve.html` (truyền thêm `num`) và `backend/scripts/seatTiers.generate.js`, generate lại `seatTiers.json`, migrate Firestore **16116 ghế** (237 mã × 68 suất diễn) → `tier:"thuy-quai", price:250000`, bỏ qua SOLD/HELD (không có ghế nào trong vùng này đã bán/đang giữ). Vì hàm `tierOf()` check `front` TRƯỚC khi check `EXIT_SIDE_UPGRADE`, ghế nào trong range số nhưng thực ra ở phía trước vẫn tự động được tính đúng theo luật phía trước (son-than/thuy-quai theo hàng), không bị dải này ghi đè sai — nên không cần cắt gọt range cho khớp tuyệt đối biên trước/sau, code tự an toàn.

**Cập nhật ngay sau đó cùng ngày — SỬA LẠI CHÍNH XÁC:** user gửi tiếp bảng số ghế lẻ/chẵn RIÊNG BIỆT (không phải 1 dải liên tục như suy luận từ ảnh ở trên — lẻ và chẵn có biên min/max khác nhau hẳn mỗi hàng, ví dụ K: lẻ 51-93 nhưng chẵn 74-94). Đã revert 16116 ghế cũ về mi-nuong rồi áp lại đúng theo bảng mới:

| Hàng | Lẻ | Chẵn |
|---|---|---|
| B | 35-61 | 36-52 |
| C | 41-69 | 42-62 |
| D | 61-75 | 48-70 |
| E | 59-85 | 42-80 |
| G | 53-87 | 42-88 |
| H | 47-93 | 60-94 |
| I | 41-65 | 50-70 |
| K | 51-93 | 74-94 |
| L | 73-101 | 82-104 |
| M | 83-103 | 86-106 |

`EXIT_SIDE_UPGRADE` đổi cấu trúc thành `{odd:[min,max], even:[min,max]}` mỗi hàng (parity-aware) thay vì 1 khoảng chung — cả `frontend/dat-ve.html` lẫn `backend/scripts/seatTiers.generate.js` (hàm `inExitRange()`). Sau khi lọc bỏ ghế không tồn tại (gap kiến trúc thật, VD K51-71 không tồn tại) và ghế rơi vào phía trước (VD G42-58, H47-62 — vẫn là Sơn Thần vì INNER_ROWS phía trước, KHÔNG đổi) còn **249 mã ghế thật/suất diễn**, migrate **16932 ghế** (249 × 68 suất) → thuy-quai/250000. Không ghế SOLD/HELD nào bị ảnh hưởng ở cả 2 vòng (revert + áp mới).

**Quy trình review đã dùng — nên lặp lại cho các lần đổi hạng ghế lớn sau này:** trước khi go-live, bật tạm `TEST_MODE = true` ở `frontend/dat-ve.html` (chỉ sửa local, không commit/push/deploy) — mode này ép mọi ghế thành AVAILABLE ở client, không gọi Firestore thật, nên user xem được đúng màu/hạng ghế qua Live Server (port 5500) mà không cần mở khóa gì trên production. Sau khi user duyệt xong mới tắt lại `TEST_MODE = false` và deploy thật.

**Đợt review 2026-09-16 phát hiện sai tiếp ở B,C,D,E (bên lẻ) — đã sửa:**

| Hàng | Lẻ cũ (sai) | Lẻ mới (đúng) |
|---|---|---|
| B | 35-61 | **35-51** |
| C | 41-69 | **41-61** |
| D | 61-75 | **47-69** |
| E | 59-85 | **51-75** |

(Chẵn B,C,D,E và toàn bộ G,H,I,K,L,M giữ nguyên như bảng trên, không đổi.) Migrate Firestore: 17 mã/suất chuyển về mi-nuong (B53-61, C63-69, D71-75, E77-85), 11 mã/suất chuyển thành thuy-quai (D47-59, E51-57) — tổng 1156 + 748 ghế trên 68 suất diễn.

Đồng thời khóa lại **K74-94 (bên chẵn)** — 33 ghế/3 suất tháng 9 — vốn đang AVAILABLE do lần "mở lại toàn bộ K74-K94" trước đó chỉ khóa lại phần lẻ (K73-93), còn phần chẵn vẫn mở; giờ khóa nốt để về đúng trạng thái "toàn bộ K74-116 đều BLOCKED cho 3 suất tháng 9" như thiết kế gốc.

**Đảo lại ngay sau đó cùng ngày:** user xác nhận việc khóa K74-94 chẵn ở trên là NHẦM — đã **mở lại AVAILABLE** (33 ghế/3 suất tháng 9). Trạng thái đúng hiện tại: K74-94 chẵn = AVAILABLE, K73-93 lẻ = BLOCKED (không đổi). Đây là trạng thái CHỐT — không tự ý khóa lại K74-94 chẵn nữa nếu không có yêu cầu mới rõ ràng.

Danh sách range bên chẵn đã khóa (cộng thêm bên lẻ toàn bộ mọi hàng): K74-116, O72-92, N74-96, M108-130, L106-128, I72-86, H96-108, G90-106, E82-98, D72-88, C64-78, B54-64, **P74-96** (P bị sót ở đợt khóa đầu 2026-09-16, bổ sung cùng ngày sau khi user phát hiện).

**Cập nhật 2026-09-16 (sau đó cùng ngày):** K74-94 mở lại toàn bộ rồi user chỉnh lại chính xác hơn: **chỉ bên chẵn K74-94 mới AVAILABLE, bên lẻ K73-93 khóa lại (BLOCKED)** — tức quay về đúng logic gốc "bên lẻ toàn bộ khóa". Trạng thái hiện tại của vùng K73-96: K73 (lẻ, luôn BLOCKED từ đầu), K75-93 lẻ (BLOCKED, khóa lại 2026-09-16), K74-94 chẵn (AVAILABLE), K95-96 (BLOCKED, chưa ai yêu cầu mở). Riêng K97-116 vẫn BLOCKED nguyên như đợt khóa gốc.

**Cập nhật 2026-09-20 — chỉ áp dụng riêng cho suất 26/9 16:30:** toàn bộ 126 ghế bên chẵn thuộc range đã khóa (P74-96, O72-92, N74-96, M108-130, L106-128, K96-116, I72-86, H96-108, G90-106, E82-98, D72-88, C64-78, B54-64) đã **mở lại AVAILABLE** — nhưng CHỈ cho suất `2026-09-26_16:30`. 2 suất còn lại (`2026-09-25_20:00`, `2026-09-27_10:00`) vẫn giữ nguyên BLOCKED y như cũ, không đụng vào. Bên lẻ mọi suất vẫn BLOCKED nguyên, không đổi.

Không có endpoint admin để khóa/mở ghế theo batch — làm bằng script Node tạm thời (`backend/scripts/tmp_*.js`, xoá ngay sau khi chạy, theo đúng quy ước) đọc `backend/scripts/seatTiers.json` làm nguồn sự thật cho mã ghế thật của từng hàng (min/max KHÔNG đủ, có nhiều lỗ hổng số ghế do kiến trúc lối thoát hiểm/WC — ví dụ hàng K thiếu 45,47,49-72; phải kiểm tra tồn tại từng mã, không suy ra từ khoảng số). Script bỏ qua (không đụng) ghế đã `SOLD` thật; ghế đang `HELD` thì cũng bỏ qua + cảnh báo để xử lý tay, không ép chuyển như cách `blockStaffSeats.js` làm với ghế staff (khối lượng đợt này lớn hơn nhiều, suất đang mở bán thật, không nên tự ý cướp hold của khách đang thanh toán dở).

Muốn mở lại các ghế này: chạy script tương tự đổi `BLOCKED` → `AVAILABLE` cho đúng danh sách mã ghế đã khóa (không có cách tự động phân biệt "từng bị BLOCKED" sau khi đã đổi, nên giữ lại danh sách mã ghế nếu cần mở lại sau).

## Gradient tối "chân" ảnh KV trang chủ — bản chốt (2026-09-16)

Sau ảnh KV mới (chữ nghệ thuật/tên vở nằm ở khoảng 7-16% tính từ đáy ảnh) + nhiều vòng chỉnh qua lại (kể cả user tự sửa tay trực tiếp qua IDE), bản CHỐT hiện tại ở `frontend/index.html`:

- `.hero-bg-overlay`: dải "mây mờ" nâu dọc đỉnh ~5% (từ đáy), tắt hẳn ở 16%. Dải ngang (90deg) đậm bên trái `.55`, giữa `.26`, phải `.06` — **CHÚ Ý: từng thử tăng đầu phải lên `.2` để đỡ "lộ chân KV" bên phải, nhưng user tự tay revert lại `.06`** — đừng tự ý tăng lại nếu không có yêu cầu mới. Box-shadow vignette 4 cạnh: `inset 0 0 55px 8px rgba(2,8,15,.2)` (giảm từ `100px 20px .4` gốc).
- `.content-atmosphere::before` (gradient đen của section Lịch diễn lấn ngược lên hero): `top:-195px` (đã qua nhiều mức: 420px gốc → 150px → 195px (+30%) → user tự sửa tay lên 230px → **user tự tay revert lại 195px**, chốt ở đây). Mask `-webkit-mask-image`/`mask-image` luôn phải scale đúng tỉ lệ theo `top` mỗi lần đổi (điểm dừng hiện tại: 27/56/83/112/139/168px, `#000` ở 195px).

Nếu cần chỉnh tiếp: đổi từng phần một, hỏi rõ đang nói phần nào ("mây mờ" dọc trong `.hero-bg-overlay` vs gradient ngang 90deg cùng chỗ vs gradient đen `.content-atmosphere::before` lấn từ dưới lên) — session này từng chỉnh nhầm giữa các phần vì tên gọi "gradient" mơ hồ, phải hỏi lại nhiều lần.

## Bán buôn toàn bộ ghế Thủy Quái còn trống suất 26/9 16:30 (2026-09-17)

Theo yêu cầu: toàn bộ ghế hạng Thủy Quái của suất `2026-09-26_16:30` đang `AVAILABLE` (chưa bán, không `BLOCKED`) đã chuyển `SOLD`, tên khách hàng chung **"Rạp Xiếc Customer"** — **218 ghế**, mỗi ghế 1 đơn + 1 vé riêng (tổng 218 đơn/218 vé, 54.500.000đ), tạo bằng đúng hàm `createManualTicket()` có sẵn trong `admin.service.js` (giống cách tạo vé tay/tiền mặt khác — `orderStatus/paymentStatus:"PAID"`, `paymentMethod:"cash"`, `source:"manual"`, không gửi mail vì không có email khách). 209 ghế `BLOCKED` và 3 ghế đã `SOLD` từ trước giữ nguyên, không đụng.

Muốn tra lại nhanh: `orders`/`tickets` where `showtimeId=="2026-09-26_16:30" && customerName=="Rạp Xiếc Customer"`.

## Trang tra cứu đơn hàng cho đối tác (2026-09-15)

Đối tác nghiệp vụ (kế toán/venue) cần xem đơn/vé thật để đối soát — thêm `frontend/partner-orders.html` (không gắn nav) gọi `POST /api/partner/orders/list` (`backend/src/routes/partner.routes.js` + `partner.service.js`), lọc theo `showtimeId`/`orderStatus`, phân trang cursor.

Bảo vệ bằng `PARTNER_API_KEY` — **key riêng, tách hẳn khỏi `ADMIN_PIN`** (PIN đó huỷ/tạo được vé thật; key này chỉ đọc, không có endpoint ghi tương ứng). Không có fallback mặc định như `ADMIN_PIN` — thiếu env thì fail-closed (`checkPartnerKey()` luôn `false`), không vô tình chạy production với key rỗng.

**Phải set `PARTNER_API_KEY` trên Render thì endpoint mới hoạt động** — đã có trong `backend/.env` local, chưa tự đẩy lên Render được (không có quyền truy cập dashboard). Gửi đối tác: link trang + giá trị key (qua kênh riêng, không nhắn chung với link).

4 composite index mới cho collection `orders` trong `firestore.indexes.json` (đã deploy) — cần cả 4 vì Firestore yêu cầu index khớp đúng tổ hợp field lọc (`showId` luôn có, cộng thêm `showtimeId`/`orderStatus` tuỳ chọn) + `orderBy(createdAt)`.

**Công cụ Admin trên cùng trang (2026-09-16):** nút "🔒 Công cụ Admin" trên `partner-orders.html` mở khoá bằng **`ADMIN_PIN`** (PIN huỷ/tạo vé sẵn có, KHÔNG phải `PARTNER_API_KEY`) — gọi `POST /api/admin/verify-pin` để xác nhận trước khi vẽ thêm cột "Thao tác" (Sửa/Xoá) trên từng dòng. Sửa gọi `POST /api/admin/orders/update`, xoá gọi `POST /api/admin/orders/delete` (`deleteOrder()`/`updateOrderCustomerInfo()` trong `admin.service.js`) — cả hai đều dùng `requirePin` + `adminLimiter` có sẵn trong `admin.routes.js`, không phải endpoint mới tách riêng rate-limit. Xoá là xoá hẳn (order + ticket liên quan, trả ghế về AVAILABLE) — không hoàn tác được, khác với `cancelTicketBySeat()` (giữ dấu vết `ticketStatus="cancelled"`).

Trang cũng có nút "Tải Excel (.xlsx)" — xuất file `.xlsx` thật (dùng thư viện SheetJS qua CDN `cdnjs.cloudflare.com/ajax/libs/xlsx`, không cần build tool) từ đúng danh sách `lastLoadedOrders` đang hiển thị sau khi lọc: header in đậm, đóng băng hàng đầu, autofilter, độ rộng cột tự tính theo nội dung dài nhất (min 10/max 45 ký tự), cột "Tiền" định dạng số có dấu phẩy ngăn nghìn (`#,##0`) thay vì chuỗi text (2026-09-16, thay cho bản CSV trước đó vì Excel hiển thị CSV xấu/cột hẹp).

## Mở 4 suất diễn tháng 10 (đều 16h30) qua link riêng `?suat=`, KHÔNG lộ lịch tháng 10 (2026-09-26)

Theo yêu cầu "khách đặt được vé của những suất đó và CHỈ những suất đó ở tháng 10, không có suất khác ở tháng 10" — đã mở đúng **4 suất, đều 16h30** (suất 20h00 dự kiến ban đầu cho 3/10 đã bỏ theo yêu cầu sau đó):

- `2026-10-03_16:30` (Thứ 7), `2026-10-04_16:30` (Chủ nhật), `2026-10-10_16:30` (Thứ 7), `2026-10-11_16:30` (Chủ nhật)

**Lớp Firestore:** mỗi suất đổi `status: "CLOSED"` → `"OPEN"` + khóa (`BLOCKED`) **453 ghế/suất** thuộc 2 hạng **VIP (vua-hung)** và **Mị Nương (mi-nuong)** (43 VIP + 410 Mị Nương, lọc từ `seatTiers.json`). Ghế Sơn Thần + Thủy Quái giữ `AVAILABLE`, mở bán bình thường. `blockNote` ghi rõ lý do — muốn mở lại VIP/Mị Nương sau thì đổi ngược `BLOCKED`→`AVAILABLE` đúng 453 mã ghế này mỗi suất. (`2026-10-03_20:00` đã được mở+khóa tương tự lúc đầu rồi **revert hoàn toàn** về `CLOSED`+`AVAILABLE` khi quyết định bỏ suất này — coi như chưa từng đụng.)

**Lớp frontend — CƠ CHẾ MỚI, khác các lần mở suất trước:** **KHÔNG đụng `SEASON_END`** (vẫn giữ nguyên ẩn tháng 10 khỏi lịch tuần công khai ở cả `index.html` lẫn `dat-ve.html`, đúng mốc khẩn cấp 2026-09-26 phía trên) — vì nới `SEASON_END` sẽ lộ nguyên cả tuần chứa các ngày này (kể cả Thứ 6 2/10, 9/10 đang `CLOSED`), vi phạm yêu cầu "không suất nào khác ở tháng 10". Thay vào đó, `frontend/dat-ve.html` thêm cơ chế **"suất xem trước"** hoàn toàn mới:

- `PREVIEW_SHOWTIMES` (object hardcode 4 showtimeId ở trên + thông tin ngày/thứ để hiển thị) và biến `previewShowKey`, set từ URL param **`?suat=YYYY-MM-DD_HH:MM`** nếu khớp whitelist (đọc lúc khởi tạo lịch, gần `SHOWTIMES_BY_DAY`).
- `currentShowKey()` trả thẳng `previewShowKey` nếu có, bỏ qua `runs`/`SHOWTIMES_BY_DAY` — đây là nơi DUY NHẤT quyết định showtimeId thật sự gửi lên backend.
- `renderSchedule()`: khi có `previewShowKey`, xoá trắng `dayTrack`/`timeRow` (không còn nút ngày/giờ nào để bấm sang suất khác), khóa `weekPrev`/`weekNext` (`disabled=true`), chỉ hiện đúng 1 dòng nhãn cố định (vd. "Chủ nhật, 04.10.2026 · 16H30"). Khách vào đúng link chỉ thấy 1 suất, không có đường điều hướng sang suất/ngày tháng 10 nào khác.
- `tryResumeHold()` (khôi phục phiên giữ ghế sau reload): kiểm tra `saved.showKey` có trong `PREVIEW_SHOWTIMES` không TRƯỚC khi gọi `findScheduleIndexByShowKey()` (hàm này chỉ tìm trong `runs`, sẽ không thấy showKey preview và xoá nhầm phiên nếu không có nhánh riêng này).
- Lý do chọn cách này thay vì nới `SEASON_END`: Chủ nhật (4/10, 11/10) theo `SHOWTIMES_BY_DAY` mặc định là 10:00 chứ không phải 16:30, và nới lịch tuần sẽ kéo theo lộ cả các ngày/suất khác trong cùng tuần — không thể đạt yêu cầu "chỉ đúng 4 suất này" nếu chỉ chỉnh `SEASON_END`.

Đã tắt lại `TEST_MODE = false` (buộc phải tắt trước khi làm bước này — trước đó từng bật `true` cục bộ để test, suýt bị lẫn vào lúc thao tác). Chưa deploy — file đang ở trạng thái sẵn sàng deploy khi được yêu cầu.

Script tạm dùng (đã xoá sau khi chạy theo đúng quy ước): `backend/scripts/tmp_openAndBlock202610.js`, `tmp_closeOct3_2000.js`, và các script audit `tmp_auditOpen202610.js`/`tmp_verifyProject.js`/`tmp_finalAudit.js`.

**Cập nhật 2026-09-26 (sau đó cùng ngày) — đã DEPLOY:** thay cơ chế "khóa cứng 1 suất qua `?suat=`, không cho điều hướng" ở trên bằng cơ chế mới cho cả 2 trang, theo yêu cầu cho khách lướt được giữa các suất đang mở thay vì chỉ xem đúng 1 suất cố định:

- `frontend/dat-ve.html`: `PREVIEW_SHOWTIMES`/`previewShowKey` đổi thành **`OPEN_SHOWTIMES`** (mảng có thứ tự, sắp theo thời gian tăng dần) + con trỏ **`openIndex`**. Mặc định `openIndex = 1` (suất gần thứ 2 trong danh sách, KHÔNG phải suất gần nhất) — chốt theo yêu cầu. `?suat=` (nếu có, khớp whitelist) ghi đè `openIndex` ban đầu. Nút prev/next (`weekPrev`/`weekNext`) giờ **lướt qua từng suất trong `OPEN_SHOWTIMES`** (trước đó bị `disabled` cứng). `renderSchedule()` không còn vẽ day-track/time-row kiểu Thứ6-7-CN (không khớp thực tế nữa — 4 suất rải rác, không liên tục); code lịch tuần liên tục cũ (`SEASON_START/END`, `runs`, `SHOWTIMES_BY_DAY`, `findScheduleIndexByDateKey`, `applyDateFromUrl`) **vẫn giữ nguyên, chỉ tạm bất hoạt** — đổi tên hàm `renderScheduleFullSeasonLegacy()` lại thành `renderSchedule()` khi mở liên tục cả mùa trở lại, khỏi viết lại từ đầu. `tryResumeHold()` khôi phục phiên giữ ghế bằng cách tìm `saved.showKey` trong `OPEN_SHOWTIMES` trực tiếp (không còn nhánh fallback vào lịch tuần — suất xem trước không nằm trong `runs`).
- `frontend/index.html`: `SEASON_START/END` + `OPEN_TIMES_BY_DATE` (dạng lịch liên tục) đổi thành **`OPEN_PAIRS`** — mảng các cặp cuối tuần đang mở thật (hiện 2 cặp: 3-4/10 và 10-11/10), mỗi cặp là 1 "run" để nút prev/next tuần vẫn hoạt động đúng như cấu trúc cũ. Mặc định `runIndex=0` (cặp gần nhất) + `selectedDay=1` (ngày thứ 2 trong cặp — vẫn là logic mặc định "Thứ 7" cũ, tái dùng nguyên vẹn). Nút "Đặt vé" đổi link từ `/dat-ve?ngay=YYYY-MM-DD` sang **`/dat-ve?suat=YYYY-MM-DD_HH:MM`** (showtimeId đầy đủ, khớp thẳng `OPEN_SHOWTIMES` bên `dat-ve.html`) vì giờ mỗi ngày chỉ có đúng 1 giờ mở thật, không cần đoán giờ mặc định theo thứ nữa.
- **Đồng bộ tay bắt buộc:** `OPEN_SHOWTIMES` (dat-ve.html) và `OPEN_PAIRS`+`OPEN_TIMES_BY_DATE` (index.html) phải khớp NHAU và khớp status `OPEN` thật trong Firestore — sửa 1 bên mà quên bên kia sẽ lệch mặc định/nhãn hiển thị (không gây lỗi bảo mật vì backend vẫn là lớp chặn thật, nhưng sai UX).
