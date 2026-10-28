# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

LumiShow is a ticketing website for a Vietnamese circus show ("Sơn Thần Thủy Quái" at Rạp Xiếc Trung Ương). It has two independent parts that are developed and deployed separately:

- `frontend/` — static, framework-free HTML/CSS/JS pages, no build step. Deployed as-is to Firebase Hosting (project `sonthanthuyquai-ticket`, see `firebase.json`/`.firebaserc`).
- `backend/` — a Node/Express API backed by Firebase Firestore, handling seat inventory/holds, PayOS payments, ticket emails/QR, and a couple of PIN/API-key-gated ops endpoints (manual ticketing, partner order reconciliation). Deployed to Render; production URL is `https://lumishow-website.onrender.com` (hardcoded as `API_BASE_URL` in the frontend pages that call it).

There is no root-level package.json tying the two together; each half has its own tooling (or none). There's also a separate Unity app (`../SonThanThuyQuai_TicketManager`, outside this repo) used at the venue gate; as of 2026-10-03 its main check-in flow calls this backend's `/api/admin/tickets/checkin*` endpoints (server-side transaction) rather than reading/writing Firestore `tickets` directly, but one debug-only reset function in the Unity app still talks to Firestore directly, which is why `firestore.rules` hasn't been fully locked down yet — see the C1/C7 note and the "Admin back office, gate check-in..." section below.

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
- `backend/.env` — `PORT`, `NODE_ENV`, `FRONTEND_URL`, `ADMIN_PIN`, `GATE_API_KEY`, `PARTNER_API_KEY`, `FILOWG`, `GATE_SCAN_SHEET_ID` (optional — Google Sheets sync no-ops silently if unset, see "Admin back office..." below), `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `CONTACT_TO_EMAIL`, `ORDER_NOTIFY_EMAIL`, `TECH_ALERT_EMAIL`, `RENDER_EXTERNAL_URL` (used to build absolute QR/email links; see local-ops memory note about it being missing locally).
- `backend/serviceAccountKey.json` — a Firebase service account key, loaded by `backend/src/config/firebase.js` (or point `FIREBASE_SERVICE_ACCOUNT_FILE` at a different file, e.g. for a second/test project).

## Backend architecture

Entry point `backend/src/index.js` wires up Express: `helmet()`, `trust proxy` (1 hop, for Render), a global `apiLimiter` (60 req/min/IP on all of `/api`, explicitly skipping `/api/payments/webhook` so PayOS bursts don't get 429'd), a strict CORS allowlist (`lumishow.vn`, `www.lumishow.vn`, `sonthanthuyquai-ticket.web.app`, plus the two `:5500` localhost origins outside production), `express.json()`, then mounts nine route modules under `/api`, a static `GET /health` (no Firestore ping — a prior version pinged Firestore per call and got rate-limited), and a final JSON error handler that never leaks stack traces. At the bottom, a `setInterval` runs `reconcilePendingOrders({ commit: true })` every 10 minutes as a standing safety net (see the "C6" note further down — the PayOS webhook isn't registered yet).

Route module → service module map (each route file also carries its own `express-rate-limit` instance sized to how sensitive/expensive the endpoint is — e.g. `adminLimiter` and `couponLimiter` are much stricter than the general `apiLimiter`):
- `booking.routes.js` → `booking.service.js` — seat states, hold create/status, and (since 2026-10-03) `GET /shows/:showId/showtimes/open` — the public, live source for which showtimes are bookable (see "Frontend đọc lịch suất diễn sống..." below).
- `payment.routes.js` → `payment.service.js` — PayOS order creation, webhook handler, status polling.
- `ticket.routes.js` — `GET /api/tickets/:ticketCode/qr.png`, generates a QR PNG on the fly via the `qrcode` package (nothing stored/looked up); used instead of an embedded base64 image because mail clients strip those.
- `contact.routes.js` → `email.service.js` — contact form → Resend email.
- `admin.routes.js` → `admin.service.js` — grew from a small `ADMIN_PIN`-gated endpoint set into a full back office (order/showtime/seat/coupon/news CRUD, conflict resolution, venue gate check-in, activity log, a hub-visibility toggle). Big enough now to have its own section — see "Admin back office, gate check-in & operational tooling" below.
- `coupon.routes.js` → `coupon.service.js` — coupon validate (display-only, doesn't consume a use); the real atomic reserve/release happens inside `payment.service.js` at order-creation time.
- `partner.routes.js` → `partner.service.js` — `PARTNER_API_KEY`-gated (also accepts `ADMIN_PIN`, see below), read-only order listing with cursor pagination, for accounting/venue reconciliation.
- `news.routes.js` → `news.service.js` — public `GET /api/news` (Firestore `news` collection, replaces what used to be a hardcoded array in `index.html`'s "tin tức" section); create/update/reorder/delete are `admin.routes.js`-gated, used by `admin-news.html`.
- `testerTicket.routes.js` → `testerTicket.service.js` — internal QA sandbox, see "Admin back office..." below. Mounted as its own router (not nested under `admin.routes.js`), so it does **not** share `admin.routes.js`'s rate limiter or activity-log middleware (Express routers mounted separately don't inherit each other's `.use()`); it declares its own lightweight limiter instead.

Firestore data model:
- `shows/{showId}/showtimes/{showtimeId}` — has a `status` (`OPEN` | `CLOSED`); `createHold()` refuses to hold seats on a non-`OPEN` showtime. `status` is also the **sole** source of truth for the public "which showtimes are open" list (`listOpenShowtimes()`) — do not infer open/closed from seat counts (see the 2026-10-03 incident below for why that was tried and reverted).
- `shows/{showId}/showtimes/{showtimeId}/seats/{seatCode}` — one doc per seat: `status` (`AVAILABLE` | `HELD` | `SOLD` | `BLOCKED`), `holdId`, `holdExpiresAt`, `tier`, `tierName`, `price`. `seatCode` is `{rowLetter}{number}` (e.g. `B12`) for regular seats or `VIP{n}` (`VIP1`-`VIP43`, tier `vua-hung`) for the VIP block. `BLOCKED` is a manually-set fourth status for seats withheld from sale (venue holdbacks) without misrepresenting them as `SOLD` in revenue reports.
- `holds/{holdId}` — top-level collection, `status` (`ACTIVE` | `EXPIRED`), `seatIds`, `expiresAt`, `bookingSessionId`.
- `orders/{orderId}` — one per checkout attempt: `orderStatus` (`PENDING_PAYMENT` | `PAID` | `CANCELLED` | `EXPIRED`), `paymentStatus`, `holdId`, customer contact info, coupon code, amount.
- `tickets/{ticketId}` — created once an order is confirmed `PAID` (one per seat): `orderId`, `ticketCode`, `ticketStatus` (`valid` | `cancelled` | `conflict_needs_review`), `checkedIn`/`checkedInAt`. Check-in now primarily goes through `POST /api/admin/tickets/checkin` (server-side transaction), but `firestore.rules` still separately allows the Unity app to flip `checkedIn: false→true` directly as a client — see the C1/C7 note below, that path isn't fully retired yet.
- `coupons/{code}` — `percentOff`, `usedCount`, etc.
- `news/{newsId}` — `img`/`youtubeId`, `href`, `org`, `title`/`desc` (each `{vi, en}`), `publishedAt`. Public read via `GET /api/news`.
- `gateScanHistory/{id}`, `adminActivityLog/{id}`, `config/hubVisibility` — operational collections for the venue gate and admin back office, see "Admin back office..." below.

Seat holding is transactional and lazily expired, not cron-driven:
- `createHold()` (`booking.service.js`) runs inside a single `db.runTransaction`: validates the showtime is `OPEN`, re-reads every requested seat to confirm it's still `AVAILABLE`, then atomically writes the hold doc and flips the seats to `HELD`.
- `cleanupExpiredHolds()` / `releaseExpiredHold()` walk `holds` where `status == ACTIVE && expiresAt <= now`, flip their seats back to `AVAILABLE`, and mark the hold `EXPIRED`. This is invoked at the top of both `getSeatStates()` and `createHold()` — there is no background job, expiry only happens as a side effect of the next read/write.
- Booking limits live in `backend/src/config/booking.config.js` (`MAX_SEATS_PER_ORDER`, `HOLD_DURATION_MS`, `MAX_ACTIVE_HOLDS_PER_SESSION`) — change limits there, not inline.

Payment/pricing money flow, all server-truth: `createPaymentForHold()` (`payment.service.js`) re-reads the real Firestore `price` for every held seat (never trusts a client-submitted amount) and, if a coupon code is present, re-validates and re-reserves it from scratch (the earlier `/api/coupons/validate` call was display-only). The PayOS webhook handler (`handlePaymentWebhook`) is idempotent on `orderStatus`, flips seats `HELD → SOLD` and the order to `PAID` inside a transaction, then creates one `tickets` doc per seat and emails them out. Note the frontend's own `tierOf()` pricing logic in `dat-ve.html` is only for pre-hold display — `GET /api/.../seats` never returns `price`, so the charge is always computed here from Firestore, not from anything the client sent.

`backend/scripts/seedSeats.js` is the source of truth for the venue layout when seeding a *new* showtime: it hardcodes `SHOW_ID`, `SHOWTIME_ID`, the row list (`ROWS`, each with a seat count), and reads per-seat tiers from `seatTiers.json` (generated by `seatTiers.generate.js`, see Commands above). It requires `../src/config/firebase` directly (run as a standalone script, not through the Express app) and writes seats in batches of 400. Any change to row layout/tiers must stay in sync with the seat-map building/pricing logic in `frontend/dat-ve.html`, since seat codes and tier boundaries must match exactly — see the seat-tier change history further down this file for how that's been done in practice.

## Frontend architecture

`frontend/` has three customer-facing pages (`index.html`, `gioi-thieu.html`, `lien-he.html`, `dat-ve.html`, `404.html`) plus a growing set of internal ops/admin tools — none linked from site nav, each fully self-contained (inline `<style>`/`<script>`, no shared JS/CSS modules, no framework or bundler). Filenames are kebab-case matching the Firebase Hosting clean URLs (the old PascalCase names 301-redirect, see Commands above).

Ops/admin pages, grouped by what they're for (see "Admin back office, gate check-in & operational tooling" below for the backend side of each):
- `admin-lumishow.html` — the hub: a grid of cards linking to every `admin-*.html` page below, `API key`-gated (`POST /api/partner/verify-key`, accepts `ADMIN_PIN` or `PARTNER_API_KEY`). A separate `FILOWG`-gated "FiLowG" unlock on this page can hide/show individual cards *on the hub* for lower-tier admins — it does not block direct navigation to a hidden page's own URL, which still has its own independent gate.
- `partner-orders.html` ("Danh sách đơn") — partner order lookup (`PARTNER_API_KEY`-gated) plus, behind a second `ADMIN_PIN` unlock ("🔒 Công cụ Admin"), inline order edit/delete and buttons that pop open `admin-orders.html`/`admin-showtimes.html`/`admin-news.html` in new tabs.
- `admin-orders.html`, `admin-create-order.html`, `admin-conflicts.html` — `ADMIN_PIN`-gated: single-order lookup/edit/resend-email/exchange-seats-or-showtime/delete; creating one manual multi-seat order in a single transaction (real emails sent); and resolving `ticketStatus: "conflict_needs_review"` tickets (seat double-booked by a race condition) by reassigning seats/amount and re-emailing.
- `admin-showtimes.html` — `ADMIN_PIN`-gated: showtime calendar view, create/open-close/delete showtimes, and per-seat bulk `AVAILABLE`/`BLOCKED` + rename. **Two different "khoá" controls that look similar but aren't**: the per-showtime Open/Closed toggle is the only thing `GET /shows/:showId/showtimes/open` reads, while the seat-level Blocked toggle only hides individual seats within an otherwise-open showtime — see the 2026-10-03 incident below for what happens when they're confused.
- `admin-news.html`, `admin-coupons.html` — `ADMIN_PIN`-gated CRUD for the `news` collection (homepage "tin tức") and for discount coupons (ported from the old `manageCoupons.js` CLI script, which still exists for direct CLI use).
- `admin-activity-log.html` — `ADMIN_PIN`-gated, read-only viewer over the `adminActivityLog` collection (every mutating `/admin/*` call, auto-logged by middleware — see below).
- `gate-scanner.html`, `gate-scan-history.html` — the venue gate's actual scanning UI and its scan-history viewer. Both prompt for a "PIN admin" field that's POSTed as `gateKey` and accepts either `ADMIN_PIN` or `GATE_API_KEY`. `gate-scanner.html` has a "check-in cả đơn" (whole-order) toggle and a "TestScan" dry-run toggle.
- `tester-ticket.html` — `ADMIN_PIN`-gated QA sandbox: books/resets fake seats and issues real QR codes against an isolated test showtime, for testers to scan with the real gate app without touching real show data.
- `preview-so-do-ghe.html`, `preview-ve-giay.html` — pure front-end preview tools with no backend calls at all: a standalone clone of `dat-ve.html`'s seat map (for QA'ing seat-tier/color/layout changes) and a mock-up of the printed-ticket/thermal-receipt layout, respectively.

`dat-ve.html` is by far the largest page (~3300 lines) and does the real work of the app:
- It procedurally builds an interactive circular SVG seat map (rows B–P, odd/even sides mirrored) purely via `document.createElementNS` calls — no charting/SVG library.
- `tierOf()` computes each seat's price tier/color client-side from hardcoded row/coordinate rules that must mirror `backend/scripts/seatTiers.generate.js` exactly (see the several seat-tier change entries further down this file for the established process, including the `TEST_MODE` flag used to visually QA tier changes against Live Server without touching production Firestore).
- `API_BASE_URL` is hardcoded to the production Render URL; `fetchSeatStates()` calls `GET /api/shows/:showId/showtimes/:showtimeId/seats` and maps backend seat `status` values (`AVAILABLE`/`HELD`/`SOLD`/`BLOCKED`) onto frontend seat-state constants. Update this URL locally when pointing at a non-production backend.
- Seat IDs used here must match the `{row}{number}` `seatCode` scheme produced by `backend/scripts/seedSeats.js` (or `VIP{n}` for the VIP block — tier `vua-hung`, currently hidden from the sidebar filter checkbox only, per commit "Tạm ẩn hạng Vua Hùng khỏi sidebar lọc" — the seats themselves are still fully visible/bookable on the map and priced normally everywhere else).
- Which showtimes are open for booking is fetched live from `GET /api/shows/:showId/showtimes/open` (`OPEN_SHOWTIME_GROUPS`, grouped client-side into weekend clusters) as of 2026-10-03 — see "Frontend đọc lịch suất diễn sống từ Firestore" further down. The older hardcoded `SEASON_START`/`SEASON_END`/`OPEN_SHOWTIMES` mechanism described in the dated sections below is dormant code (`renderScheduleFullSeasonLegacy()`), kept in case the site goes back to a continuous full-season calendar, not the live path.

## Admin back office, gate check-in & operational tooling (added 2026-10)

Everything under `/api/admin/*` is wrapped by two pieces of middleware declared once in `admin.routes.js`, applying automatically to every route added there — no per-endpoint boilerplate needed: an `adminLimiter` (300 req/15min, counts only failed requests toward the limit) and a response-wrapping logger that writes every successful mutation to the `adminActivityLog` Firestore collection via `logAdminActivity()` (`activityLog.service.js`) by hooking `res.json()` once, so new `/admin/*` endpoints get activity logging for free without anyone remembering to add a line. Read-only/high-volume paths opt out via `SKIP_LOG_PATHS`; credentials (`password`/`apiKey`) are always stripped before logging. `admin-activity-log.html` is the read-only viewer over this collection.

**Key hierarchy (deliberate, not an oversight):** four independent secrets, each compared with `crypto.timingSafeEqual`, form a one-directional hierarchy — `ADMIN_PIN` (the "superior" key) is also accepted everywhere `GATE_API_KEY` or `PARTNER_API_KEY` is checked (`checkGateKey()` in `admin.service.js`, `checkPartnerKey()` in `partner.service.js` each do `checkPin(key) || <strict key check>`), so staff can use one PIN everywhere while partner/gate keys issued separately — or baked into an already-built Unity APK — keep working unchanged. The one exception is `FILOWG` (`checkFilowgKey()`): it deliberately does *not* also accept `ADMIN_PIN`, because its whole purpose is letting a super-admin control what a PIN-holding "lower-tier" admin sees on the hub; accepting the PIN there would defeat it.

**Venue gate check-in** (replaces the old direct-Firestore C1/C7 path — see that note below for current status): `POST /api/admin/tickets/lookup` (read-only preview), `/checkin` (single ticket), `/checkin-order` (check in every ticket sharing one `orderId` from a single scan), `/scan-history` — all `GATE_API_KEY`-gated (`requireGateKey`) with their own `gateLimiter` (3000/15min, much higher than `adminLimiter` since scanning is continuous all evening). The shared transaction core (`checkInTicketDoc()` in `admin.service.js`) classifies every scan into one outcome (`NOT_FOUND`/`CANCELLED`/`CONFLICT`/`INVALID_STATUS`/`WRONG_DATE`/`ALREADY_CHECKED_IN`/`READY`) by checking `ticketStatus === "valid"` **and** the showtime date matches today (Asia/Ho_Chi_Minh, explicit TZ) **and** `checkedIn === false` — the old client-side Unity logic only checked `checkedIn`, so a `cancelled` or `conflict_needs_review` ticket could slip through; this is the actual fix, not just a relocation. `dryRun: true` ("TestScan" toggle in `gate-scanner.html`) runs the same classification but skips the Firestore write, so the same QR can be rescanned indefinitely while testing. Every scan is logged to `gateScanHistory` (top-level collection, capped at 100 docs, oldest pruned on write) regardless of outcome — separate from `adminActivityLog`, which excludes these paths via `SKIP_LOG_PATHS` due to volume. Successful real (non-test) check-ins also get mirrored to a Google Sheet by `googleSheets.service.js` (needs `GATE_SCAN_SHEET_ID`; both exported functions silently no-op if that env var is unset) — one tab per day named `"Checkin D/M"`, rows appended via `insertDataOption: "OVERWRITE"` specifically so a fixed per-tier summary block pinned at `J1:K6` never gets pushed down by new rows.

**`firestore.rules` is still not fully locked down** — see the C1/C7 note further down for the detailed status; short version: steps 1-2 (backend endpoint + Unity's main check-in call migrated) are done, but Unity's debug-only `ResetTicketCheckIn()` still writes Firestore directly, so the rule carve-out for `tickets` can't be removed yet without breaking that debug button.

**FiLowG hub visibility**: `getHubVisibility()`/`setHubVisibility()` in `admin.service.js` read/write a single doc `config/hubVisibility` (`{cardId: boolean}`; a missing field defaults to visible, so a newly-added card isn't silently hidden). Purely cosmetic and global — hiding a card hides that tile on `admin-lumishow.html` for every viewer, it does not restrict the underlying page's own PIN/key gate.

**Manual order creation — two different tools, don't confuse them:** `createManualTicket()` (older; one seat → one order+ticket; used for the "Rạp Xiếc Customer" wholesale split-ticket sale, see the dated section below) never sends email, regardless of whether `customerEmail` is filled in. `createManualOrder()` (`POST /api/admin/orders/create`) is newer and different: one order with N seats created in a single transaction (re-reads real seat prices, never trusts a client-sent amount), and the *route handler* does send both the real customer ticket email and the internal order-notification email right after (soft-fail — a failed send doesn't undo the already-created order; `sendTicketEmail()` itself skips silently if `customerEmail` is blank). As of 2026-10-28, `admin-showtimes.html`'s seat-editor "Đã bán (Sold)" bulk tool also calls this (single merged order for every selected seat) instead of looping `createManualTicket()` per seat — see the dated note below. Capped at `MAX_MANUAL_ORDER_SEATS = 200` (a Firestore transaction allows at most 500 writes, and this costs `2N+1`), a separate, much higher constant from the public booking flow's `MAX_SEATS_PER_ORDER` (15) — this function is only reachable via `ADMIN_PIN`, never by a customer, so there's no reason to share that cap. Prefer `createManualOrder()` over `createManualTicket()` for any manual sale where the customer should actually receive something by email, or where seats should be tracked as one order.

**Cập nhật 2026-10-28 — "Đã bán" ở `admin-showtimes.html` giờ gộp 1 đơn:** trước đó, chọn N ghế rồi bấm "Đã bán" gọi `createManualTicket()` **N lần riêng** (N đơn/N vé tách lẻ, không gửi mail) — phát hiện khi điều tra 28 đơn tách lẻ của khách "TRÀ.MY" (`showtimeId 2026-10-31_16:30`, tạo cách nhau ~150ms/lệnh, khớp đúng nhịp loop). Đã đổi sang gọi `createManualOrder()` **1 lần** với cả mảng `seatIds` (xem đoạn trên) — tất-cả-hoặc-không-gì trong 1 transaction; 1 ghế lỗi (đã bán/giữ) sẽ chặn CẢ LÔ với lỗi nêu đúng ghế đó, không còn tự "bán phần còn lại" như cũ. Nút "Hoàn tác" (`saveLastCommand`/`seUndoBtn`, lưu `localStorage`) thêm nhánh `type: "ORDER"` gọi `/admin/orders/delete` 1 lần thay vì loop `/admin/tickets/cancel`. 28 đơn TRÀ.MY cũ đã được gộp thủ công về lại 1 đơn (`seatIds`/`amount` cộng dồn, 27 ticket còn lại trỏ `orderId` về đơn sống sót, 27 đơn rác xoá) bằng script `tmp_*.js` một lần, không lặp lại được tự động cho ca tương tự sau này nếu cần.

**Conflict resolution**: `ticketStatus: "conflict_needs_review"` is set elsewhere (`payment.service.js`, during PayOS webhook finalization) when a payment succeeds but the seat was already taken by the time the ticket gets finalized — a genuine race condition, not a bug to "fix away" (code comments reference a real past incident this way). `admin-conflicts.html` → `listConflictTickets()` / `getSeatPrices()` / `resolveConflictTickets()` in `admin.service.js`: lists affected orders, lets staff price out replacement seats, then in one transaction marks the old tickets `cancelled`, issues new `valid` tickets on the replacement seats, updates the order's `seatIds`/`amount`, and the route re-sends the ticket email with the new QR codes.

**Locked-zone seat release fix**: see "Lỗi ghế trong khu khoá bị thả về AVAILABLE..." below for the incident that motivated it; the durable fix is `releaseStatusFor(seatId)` in `admin.service.js`, which every "give the seat back" code path (`cancelTicketBySeat()`, `cancelOrderSeats()`, `deleteOrder()`, `exchangePaidOrderTickets()`) now calls instead of hardcoding `"AVAILABLE"` — it checks `backend/scripts/lockedZoneSeats.json` (a generated snapshot of every seat currently `BLOCKED` for the "không được thầu bán" reason) and releases to `BLOCKED` instead whenever the seat belongs to that zone.

**Tester ticket sandbox** (`tester-ticket.html` → `testerTicket.routes.js`/`testerTicket.service.js`): isolated under a fixed `TEST_SHOW_ID = "tester-ticket"` and a showtime ID that's always `"{today}_TESTER"` (regenerated daily, same Asia/Ho_Chi_Minh date-key logic as the gate's date check — must stay in sync, or test tickets will misclassify as `WRONG_DATE` overnight). Tickets/orders are real documents in the normal top-level `tickets`/`orders` collections (so the real gate-scanner can look them up/check them in exactly as-is for testing), but every real-data query elsewhere hardcodes the real show ID, so test data is excluded by construction rather than by a filter someone has to remember to add. `resetTestShowtime()` force-overwrites all test seats back to `AVAILABLE` regardless of current status (safe only here — no real customer is ever behind a test seat). `createTestTicket()` ticket codes are prefixed `LS-TEST-` and only ever email the address entered in the test form — it never triggers the internal order-notification or conflict-alert emails, so test runs don't spam ops inboxes.

## Conventions

Comments, log messages, and user-facing strings throughout the codebase (both backend and frontend) are written in Vietnamese, consistent with the domain vocabulary already in use (e.g. `ghế` = seat, `giữ ghế` = hold seat, `suất diễn` = showtime, `hạng ghế` = seat tier). Match this when adding new code/comments in these files.

There's no automated test suite — changes to seat/pricing logic are verified with disposable `backend/scripts/tmp_*.js` scripts (deleted right after running) and, on the frontend, manual walkthroughs via Live Server with `dat-ve.html`'s `TEST_MODE` flag flipped on locally (never committed on) before a change goes live. See the dated history sections below for the concrete precedent each time this codebase's pricing, seat-blocking, season, or security posture has changed — they carry context (what was tried, reverted, and why) that isn't recoverable from the code alone.

Two other root-level `.md` files are living references, not architecture docs — don't fold their content into this file, just keep them in sync with reality:
- `SEAT_ZONE_COLORS.md` — maps the 8 color-coded zones from a venue-supplied seat-map photo to real seat-code ranges per row, so a user request like "sửa khu màu đỏ" can be resolved to exact seat codes without re-deriving it from scratch. Only covers regular seats (B–P), not VIP. Stale if `SEAT_XY` ever changes (seats added/moved) — would need rebuilding from a fresh photo, not derivable from code.
- `SESSION_LOG_2026-09-18.md` — a dated, chronological ops/bug log from one specific session (distinct from the dated sections below, which are curated architecture-relevant history). Worth skimming for forensic context on data-integrity issues, but treat it as a snapshot of 2026-09-18, not current state.

## Lỗ hổng bảo mật đã biết, HOÃN sửa (audit 2026-09-12)

Đã audit toàn diện 2026-09-12 và vá 16 lỗi (xem git log quanh commit `41eb4c0`: đối chiếu số tiền PayOS, giữ chỗ coupon atomic, chặn suất đã diễn, thực thi giới hạn hold/phiên, rate limiter, v.v.). Còn 3 hạng mục **hoãn có chủ đích** — nhắc lại khi muốn sửa:

- **C6 — MỘT NỬA ĐÃ VÁ (2026-09-16), webhook PayOS vẫn CHƯA đăng ký:** `backend/src/services/reconcile.service.js` (`reconcilePendingOrders()`) quét mọi `orders` có `orderStatus == "PENDING_PAYMENT"`, hỏi thẳng PayOS từng đơn. `backend/src/index.js` chạy hàm này mỗi 10 phút nền (`commit:true`) khi instance còn thức — tự chốt vé (đã trả tiền nhưng khách đóng tab trước khi poll xác nhận) VÀ tự chuyển `orderStatus -> "EXPIRED"` nếu PayOS xác nhận chưa trả và đơn đã quá `EXPIRE_AFTER_MS` (60 phút). Ca khách "AN" ngày 2026-09-11 (đơn gốc treo `order_73f45941...`) và 5 đơn treo khác (cũ nhất >5 ngày) đã được dọn thủ công 2026-09-16 bằng `node scripts/reconcilePendingOrders.js --commit`.

  **Vẫn còn hở:** Render free có thể ngủ đông khi vắng traffic — lúc đó vòng lặp 10 phút không chạy, đơn treo phải chờ tới lần instance thức dậy tiếp theo mới được đối soát (không phải real-time, nhưng không còn "treo vĩnh viễn" như trước). Đăng ký webhook thật vẫn là cách đúng để tức thời — endpoint `POST /api/payments/webhook` đã có sẵn và đã bỏ rate-limit, cần trả 200 cho payload test rồi confirm trên PayOS dashboard (cần quyền truy cập dashboard PayOS, chưa tự làm được).

- **C1 + C7 — MỘT NỬA ĐÃ VÁ (2026-10-03), bước 3+4 còn lại:** 4 bước sửa đã ghi trước đây — (1) thêm endpoint backend, (2) sửa app Unity gọi qua đó, (3) build lại APK, (4) khoá `firestore.rules`. Đã xong bước 1+2:
  - **Backend:** `POST /api/admin/tickets/checkin` (`checkInTicketByCode()` trong `admin.service.js`, route trong `admin.routes.js`) — transaction server-side là nguồn sự thật DUY NHẤT: chỉ cho qua khi `ticketStatus === "valid"` (từ chối rõ ràng nếu `cancelled`/`conflict_needs_review` — phát hiện cụ thể lúc audit: vé huỷ mà chưa từng check-in vẫn lọt qua được logic cũ vì nó chỉ nhìn field `checkedIn`) + đúng ngày suất diễn hôm nay (so `showtimeId` theo `todayKey`, giống `listUpcomingShowtimes()`) + `checkedIn === false`. Khoá riêng `GATE_API_KEY` (fail-closed như `PARTNER_API_KEY`, KHÔNG dùng `ADMIN_PIN` vì màn hình quét không đi qua bước nhập PIN) — **cần set trên Render thì app thật mới gọi được**, đã có trong `.env` local. Có `gateLimiter` riêng (3000/15 phút, cao hơn hẳn `adminLimiter` vì tần suất quét liên tục) và path này bị loại khỏi `adminActivityLog` (`SKIP_LOG_PATHS`) vì tần suất quá cao so với thao tác admin tay. Verify bằng 7 ca thật qua script tạm (đúng/sai key, không tồn tại, lần 2 "đã check-in", `cancelled`, `conflict_needs_review`, sai ngày) — đều đúng kỳ vọng.
  - **Unity (`../SonThanThuyQuai_TicketManager/Assets/Scripts/FirebaseManager.cs`):** `CheckInTicket()` đổi hẳn từ Firestore Client SDK (`WhereEqualTo`/`UpdateAsync`) sang `UnityWebRequest` POST tới endpoint trên — giữ nguyên chữ ký public nên `TicketManager.cs`/`CameraScanner.cs` không cần đổi gì. `ResetTicketCheckIn()` (debug-only, reset `checkedIn=false` để test lại) **CHƯA đổi**, vẫn đọc/ghi Firestore trực tiếp — nghĩa là bước 4 (khoá `firestore.rules` về `if false` toàn bộ) **CHƯA làm được**, vì làm vậy sẽ gãy luôn nút debug reset. Cần quyết định: bỏ hẳn `ResetTicketCheckIn` (chuyển qua gọi backend) trước khi khoá rules, hoặc chấp nhận giữ `allow update` hẹp hơn (chỉ chiều `true->false`, ngược lại với rule cũ) riêng cho mục đích test.
  - **Còn lại:** set `GATE_API_KEY` trên Render (chưa có quyền dashboard, như `PARTNER_API_KEY`/webhook PayOS ở C6), build lại APK với `apiBaseUrl`/`gateApiKey` đã điền đúng trong Inspector (KHÔNG commit giá trị `gateApiKey` thật vào source Unity), rồi mới khoá `firestore.rules`.

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

**➜ Cập nhật (2026-10-11):** `checkPartnerKey()` giờ **cũng chấp nhận `ADMIN_PIN`** (`checkPin(key) || checkPartnerKeyStrict(key)`), để nhân viên nội bộ dùng đúng 1 PIN cho mọi trang quản trị kể cả hub `admin-lumishow.html`. `PARTNER_API_KEY` gốc vẫn hoạt động y như cũ cho đối tác ngoài đã được cấp key riêng — câu "không có fallback" ở trên chỉ còn đúng cho trường hợp thiếu cả 2 env. Xem mục "Admin back office, gate check-in..." ở trên cho toàn bộ cấu trúc phân cấp khoá.

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

  **➜ Mục "Đồng bộ tay bắt buộc" ở trên KHÔNG CÒN ÁP DỤNG** kể từ mục "Frontend đọc lịch suất diễn sống từ Firestore" bên dưới (2026-10-03) — cả 2 file giờ tự fetch, không còn mảng hardcode `OPEN_SHOWTIMES`/`OPEN_PAIRS` nữa.

## Lỗi ghế trong khu khoá bị thả về AVAILABLE khi huỷ/xoá/đổi đơn — đã vá (2026-10-03)

**Phát hiện thực tế:** suất `2026-10-04_16:30`, nhân viên đổi vé cho khách Võ Thị Minh Nguyệt (B17/B19/B21 → H54/H56/H58) lúc 13:24. Ba ghế cũ B17/B19/B21 đều thuộc khu "không được thầu bán" (toàn bộ lẻ + range chẵn, xem mục "Khóa 1 phần ghế") — chỉ có status khác AVAILABLE/BLOCKED trước đó vì được bán cho Nguyệt **trước khi khu này bị khoá** (hồi tháng 9). Code trả ghế lại set cứng `"AVAILABLE"` không kiểm tra khu khoá, nên cả 3 ghế "sáng lên" bán được giữa khu khoá. Hậu quả thật: lúc 14:28, khách **Đặng Liên** (SĐT `0828047799`) mua được B17+B19 (600.000đ, đã thanh toán, đã nhận mail vé) trước khi B21 được khoá tay kịp lúc 15:04. **Theo quyết định của user: không đụng vào đơn của Đặng Liên, để bộ phận vận hành venue tự xử lý — không phải việc kỹ thuật.**

**Đã vá tận gốc** — lỗi này nằm ở CẢ 3 hàm "trả ghế lại" trong `admin.service.js`, không riêng đổi vé:
- `backend/scripts/lockedZoneSeats.json` (mới) — nguồn sự thật cho khu khoá, 350 mã ghế, sinh bằng cách union mọi ghế đang `BLOCKED` với đúng blockNote "Khóa 1 nửa sơ đồ..." trên TOÀN BỘ suất diễn hiện có (không hardcode theo hàng/số nữa — đọc thẳng từ Firestore thật).
- `releaseStatusFor(seatId)` — `BLOCKED` nếu nằm trong `lockedZoneSeats.json`, ngược lại `AVAILABLE` như cũ. Dùng ở `cancelTicketBySeat()`, `deleteOrder()`, `exchangePaidOrderTickets()` (cả nguồn lẫn đích đều qua đúng 1 hàm này).
- Ghế bị khoá lại tự động mang `blockNote` riêng ("Khoá lại tự động — ghế thuộc khu không-được-thầu-bán...") để phân biệt với khoá tay/khoá hàng loạt gốc.

**Nếu phát hiện ca tương tự sau này** (ghế lẻ "sáng lên" giữa khu đã khoá sau 1 thao tác đổi/huỷ/xoá đơn): kiểm tra `updatedAt` của ghế đó khớp giờ nào trong lịch sử đơn hàng liên quan (orders/tickets cùng showtimeId) để tìm đúng thao tác gây ra — đừng giả định ngẫu nhiên, luôn có 1 hành động cụ thể đứng sau.

## Frontend đọc lịch suất diễn sống từ Firestore (2026-10-03)

Thay thế hoàn toàn cơ chế mảng hardcode `OPEN_SHOWTIMES` (dat-ve.html)/`OPEN_PAIRS`+`OPEN_TIMES_BY_DATE` (index.html) mô tả ở mục "Mở 4 suất diễn tháng 10..." phía trên — lý do: khoá/mở suất qua `admin-showtimes.html` trước đây KHÔNG tự phản ánh lên lịch khách thấy, phải tự tay sửa 2 mảng + deploy lại mỗi lần (dễ quên, đã từng gây lệch UX).

- **Backend:** `GET /api/shows/:showId/showtimes/open` (public, không cần PIN/key, route trong `booking.routes.js`, logic trong `booking.service.js:listOpenShowtimes()`) — trả mảng `showtimeId` đang `status:"OPEN"` VÀ từ hôm nay trở đi (lọc phần ngày >= hôm nay, bỏ suất đã qua dù status vẫn OPEN).
- **`frontend/dat-ve.html`:** `OPEN_SHOWTIME_GROUPS` đổi từ `const` hardcode thành `let [] ` — `groupOpenShowtimes(showtimeIds)` tự gom danh sách phẳng thành cấu trúc nhóm(tuần)->ngày->giờ (ngày cách nhau <= 2 ngày lịch = cùng 1 cụm cuối tuần, không hardcode cặp ngày cụ thể). `fetchOpenShowtimeGroups()` gọi lúc khởi động (mục 15), set `OPEN_SHOWTIME_GROUPS` trước khi `renderSchedule()` chạy lần đầu. `renderSchedule()`/`loadShow()` có guard cho trường hợp rỗng (fail closed — báo "Hiện chưa mở bán suất diễn nào" thay vì crash).
- **`frontend/index.html`:** tương tự — `OPEN_PAIRS`/`OPEN_TIMES_BY_DATE` giờ được `applyOpenShowtimes(showtimeIds)` dựng động từ cùng endpoint, gọi trong IIFE async trước `renderWeekend()`.
- Đã verify: thuật toán gom nhóm chạy với dữ liệu thật hiện tại (5 showtimeId) cho kết quả **giống hệt byte-for-byte** mảng hardcode cũ.
- TEST_MODE (dat-ve.html) vẫn giữ nguyên tinh thần cũ — khi bật, `fetchOpenShowtimeGroups()` trả dữ liệu giả lập cố định thay vì gọi mạng thật.

### Sự cố ngay sau khi deploy — 2 cơ chế "khoá" bị lẫn, ĐÃ SỬA ĐÚNG (2026-10-03, cùng ngày)

Ngay sau khi deploy cơ chế trên, phát hiện suất `2026-10-03_16:30` vẫn hiện trên lịch khách dù "đã khoá" theo ý admin — vào xem thì "Còn trống: 0 ghế" (toàn bộ 1193 ghế đều `BLOCKED`/`SOLD`). Nguyên nhân: `admin-showtimes.html` có **2 nút "Khoá" khác mục đích hoàn toàn, dễ nhầm**:
1. **Nút "Khoá"/"Mở" theo từng suất** (toggle `status` OPEN↔CLOSED, gọi `/admin/showtimes/set-status`) — đây mới là cơ chế đúng để đóng **nguyên 1 suất diễn**, và là field DUY NHẤT mà `listOpenShowtimes()` dựa vào.
2. **Nút "Khoá (Blocked)" trong trình sửa sơ đồ ghế** (`/admin/seats/bulk-update`) — chỉ để khoá **từng ghế riêng lẻ** trong 1 suất (vd giữ chỗ VIP/khu không-được-thầu-bán), KHÔNG đổi `status` của suất.

Suất `2026-10-03_16:30` đã bị khoá bằng cách **2** (bulk-block hết toàn bộ ghế) thay vì cách **1**.

**Thử sai 1 lần trước khi sửa đúng:** ban đầu vá bằng cách thêm điều kiện "còn >= 1 ghế AVAILABLE" vào `listOpenShowtimes()` — **ĐÃ REVERT**, vì đây là vá triệu chứng sai gốc: số ghế trống không phản ánh đúng Ý ĐỊNH khoá của admin (vd 1 suất còn vài ghế nhưng admin vẫn muốn coi là đã đóng sớm vì lý do khác). Nguồn sự thật phải là field `status`, không phải suy luận từ số ghế.

**Sửa đúng:** gọi `setShowtimesStatus()` đổi `status` suất `2026-10-03_16:30` → `"CLOSED"` cho khớp đúng ý định admin, giữ `listOpenShowtimes()` CHỈ lọc theo `status` như thiết kế gốc.

**Quy tắc vận hành rút ra — áp dụng cho mọi lần "khoá suất" sau này:** muốn đóng **nguyên 1 suất diễn**, luôn dùng nút "Khoá"/"Mở" theo suất (đổi `status`) — KHÔNG dùng nút "Khoá (Blocked)" trong trình sửa sơ đồ ghế để bulk-block hết toàn bộ ghế như cách thay thế, dù kết quả nhìn bề ngoài giống nhau (không đặt được ghế nào). Nút khoá-từng-ghế chỉ nên dùng cho khoá **một phần** sơ đồ (giữ VIP, khu không-được-thầu-bán...), không phải để đóng cả suất.
