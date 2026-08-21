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
