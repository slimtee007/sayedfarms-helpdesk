# SayedFarms Helpdesk — Bug Report & Fix Log

**Branch:** `arena/01a0a90e-sayedfarms-helpdesk` · **Base commit:** `41ae40b`

Everything below was **reproduced**, not guessed:

- REST + Socket.IO black-box suites against the live backend (78 checks, 54 failing at diagnosis time)
- The real `App.jsx` rendered in jsdom (fresh DOM per scenario) driven by simulated clicks/keystrokes
- An AST scope analysis (acorn + acorn-jsx) of every JSX file
- `node --check` on every backend file, `vite build`, and `oxlint`

Status legend: **FIXED** = fixed in this branch and regression-tested · **OPEN** = diagnosed, not yet fixed.

---

## FIXED in this branch

### 1. Blank page on the entire Agent Console (`ReferenceError: chatTicketId is not defined`) — FIXED
The per-ticket chat feature (merged in PR #4) copied the chat-modal block from `CustomerPortal` into
`AgentConsole` without copying its `useState`. `chatTicketId` / `setChatTicketId` were read at
`App.jsx:1565-1573` but never declared, so **every** agent route (`/agent/tickets`, `/agent/inventory`,
`/agent/users`) threw during render, and with no error boundary the whole app unmounted to a blank page —
including immediately after a successful admin login.

Fix (`frontend/src/App.jsx`):
- declared `const [chatTicketId, setChatTicketId] = useState(null);` in `AgentConsole`;
- added the missing **Chat** button per ticket row (with unread-style message count) so the feature is
  actually reachable from the agent side — previously employees could chat but agents never could;
- added an `ErrorBoundary` around the router so any future render error shows a recoverable message
  ("Try again / Reload / Sign out & clear session") instead of a silent white screen;
- guarded the `localStorage` session reads so a corrupt `user` value is discarded instead of throwing in a
  `useState` initialiser;
- replaced the route guards with a single `loggedIn` flag. A token with a missing/role-less user used to
  bounce `/portal → /login → /portal` forever (another blank page).

Verified: 10/10 regression checks pass, including "sign in as admin lands on a rendered Agent Console",
"clicking Chat opens the thread", and "an agent reply is persisted on the ticket".

### 2. One anonymous socket emit killed the whole backend — FIXED
`server.js` dereferenced `data.ticketId` in the `send_ticket_message` handler with no guard, no try/catch,
no error middleware and no `uncaughtException` handler, so
`io(host).emit('send_ticket_message', null)` exited the process (reproduced twice: `ECONNREFUSED` after).
With socket.io CORS at `origin: '*'`, any browser on any origin could do this.

Fix (`backend/server.js`): payload guards on `send_message` / `join_ticket` / `leave_ticket` /
`send_ticket_message`, plus process-level `uncaughtException` / `unhandledRejection` handlers that log
loudly instead of exiting. Verified: null, string, and partial payloads now leave the server answering 200.

### 3. Ticket chat messages silently vanished when the socket wasn't ready — FIXED
`TicketChatModal` sent only via `socket.emit`, so a message typed while the socket was still connecting
(or after it dropped) disappeared with zero feedback. Sends now go through the existing
`POST /api/tickets/:id/messages` endpoint (server persists **and** broadcasts), the socket stays the live
receive path, echoes are de-duplicated by message id, and a failed send restores the draft and shows an
inline error instead of swallowing it.

### 4. No authentication or authorization anywhere — FIXED (branch `arena/01a0ae1d-sayedfarms-helpdesk`)
`backend/server.js` now issues real signed JWTs (`jsonwebtoken`, 12 h expiry, `JWT_SECRET` from env —
refuses to boot in production without one) and verifies them in `requireAuth` / `requireAgent`
middleware on every non-public endpoint. Passwords are bcrypt hashes (`bcryptjs`, 10 rounds) with a
boot-time migration that hashes any plaintext leftovers in place. Role is looked up fresh from the DB
on each request, so demotions and deletions take effect immediately. Every attack in the original
evidence row now fails closed: anonymous `GET /api/users`, user delete/promote, asset destroy,
ticket close/reassign, and posting as `"Fake IT Admin"` return 401/403 (sender identity for chat is
derived from the verified session on both REST and sockets). Socket.IO carries the session token in
`socket.handshake.auth`; unauthenticated emits and ticket-room joins for tickets you don't own are
ignored. CORS is allow-listable via `CORS_ORIGIN` (Bearer tokens are not ambient credentials, so a
foreign origin can't ride a session even with the permissive dev default).

Also fixed along the way: **#13** (employees' `GET /api/tickets` is server-side scoped to their own;
agents see all), **#14** (`created_by` id + `created_by_name` stamped from the session, legacy tickets
backfilled by reporter name), **#16** (signup/login/forgot-password all compare normalised emails).
Partials: **#11** (admin seed is env-overridable via `ADMIN_EMAIL`/`ADMIN_PASSWORD` and only fires
when *no* agent exists), **#17** (deleting a user re-homes their ticket/asset assignments to
`Unassigned`), **#24** (`DELETE` on a missing user/asset id is now 404; OTP compared as strings so a
JSON-number code is accepted).

Verified: black-box suite against the live backend covering signup/login hashing + JWT shape,
anonymous access (401 everywhere), employee scoping (own tickets only, cancel-own-only, chat-own-only,
`GET /api/agents` names-only), agent powers (promote/demote, self-role-change + self-delete + last-agent
refusals), case-insensitive duplicate signup rejection, reset-password re-hashing, and socket auth.

### 5. Plaintext passwords committed to git — FIXED (tracking) + ACTION REQUIRED (history)
`backend/db.json` is removed from git tracking and covered by `.gitignore`; fresh checkouts auto-seed
a local copy on first boot, and all stored passwords are bcrypt hashes. The leaked values are rotated
(the committed accounts' passwords no longer exist anywhere — seeds are env-overridable and the old
file is not shipped). **Still required:** the old `db.json` contents live on in main's history —
purge with `git filter-repo --path backend/db.json --invert-paths` (and rotate any reused
credentials) before real deployment. Documented in `README.md`.

### 6. Anyone can self-register as an IT Agent — FIXED
`role` from the signup body is ignored server-side (every public signup is `role: 'user'`), the
"IT Staff (Agent Console)" option and the whole Account Type dropdown are removed from the signup
form, and the client no longer sends `role` at all. Promotion is agent-only via `PATCH /api/users/:id`
(which itself now requires an agent session, blocks self-role-change, and blocks demoting the last agent).

### 12. Forgot-password is a dead end as shipped — FIXED (branch `arena/01a0ae1d-sayedfarms-helpdesk`)
`/forgot-password` now renders the existing `src/pages/ForgotPassword.jsx` (via a `ForgotPasswordRoute`
wrapper that navigates back to `/login`), and the ~150-line inline duplicate was deleted from
`AuthScreen`, which is login/signup only again. The wired-up component honours the server's response
contract: `devOtp` renders the development-code box when SMTP isn't configured, `emailSent` drives the
step-2 copy, and success auto-redirects to sign-in. Small consistency pass on the revived component:
API base comes from an `apiBase` prop (same `VITE_API_URL || ''` value as the rest of the app),
accent colour aligned to the app's `#0052CC`, email placeholder typo fixed. The login form's
"Forgot password?" link routes to `/forgot-password`.

Verified: `vite build` + `oxlint` clean; `ForgotPassword` rendered in jsdom — a mocked SMTP-down
response shows the dev code box, a mocked SMTP-up response shows the inbox message with no dev code,
reset success auto-redirects, and no `resetStep`/`handleRequestOtp` remnants remain in `App.jsx`.

---

## OPEN — security (fix before any real deployment)

| # | Finding | Evidence |
|---|---|---|
| 4 | ~~No authentication or authorization anywhere~~ — **FIXED**, see FIXED §4. | — |
| 5 | ~~Plaintext passwords committed to git~~ — **tracking FIXED**, see FIXED §5; **history purge still required.** | — |
| 6 | ~~Anyone can self-register as an IT Agent~~ — **FIXED**, see FIXED §6. | — |
| 7 | **Password reset / login are brute-forceable.** 200 wrong OTPs → all HTTP 400, no lockout or delay (10⁶ keyspace, 10-minute validity); 40 wrong admin passwords → all HTTP 400. No rate limiter installed. | `server.js:224-227` |
| 8 | **Mass assignment.** `Object.assign(ticket, req.body)` let a client rewrite a ticket's primary key to `"hijacked"`, orphaning the record; same pattern on inventory. | `server.js:292,336` |
| 9 | **Live chat broadcasts every conversation to every connected client** (`io.emit`), and nothing is persisted. | `server.js:349` |
| 10 | **Account enumeration** on forgot-password (404 vs 200). | `server.js:137` |
| 11 | **Default admin credentials hard-coded and re-seeded on every boot** (`admin@sayedfarms.com` / `Admin@12345`), even if deleted. **PARTIAL:** seed is now env-overridable (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, bcrypt-hashed) and only fires when *no* agent exists; the documented dev default remains for local first boot. | `server.js` ensure-admin block |

## OPEN — functional

| # | Finding | Evidence |
|---|---|---|
| 12 | ~~Forgot-password is a dead end as shipped~~ — **FIXED**, see FIXED §12. | — |
| 13 | ~~No per-user ticket scoping~~ — **FIXED** with §4 (server-side scoping; employees see own tickets only). | — |
| 14 | ~~Reporter identity lost~~ — **FIXED** with §4 (`created_by` + `created_by_name` from session; legacy backfilled). | — |
| 15 | **No input validation**: empty signup/ticket/asset bodies all return 200; 1-character passwords accepted on signup and reset. | `server.js:174-183,270-287,318-331` |
| 16 | ~~Duplicate-email guard bypassable by case~~ — **FIXED** with §4 (all comparisons normalised; signup rejects case variants). | — |
| 17 | **Assignments keyed by display name**, not id: renaming a user orphans every ticket/asset assignment; duplicate names are indistinguishable. **PARTIAL:** deleting a user now re-homes their assignments to `Unassigned` instead of stranding them; id-keyed assignments still open. | `server.js` DELETE user |
| 18 | **`Date.now()` primary keys collide** (6 concurrent signups → 5 unique ids); `DELETE /api/users/:id` uses `filter`, so a collision deletes both accounts. | `server.js:179,241,273,321` |
| 19 | **Ticket creation swallows failures** — `handleCreateTicket` never checks `res.ok`, then closes the modal and clears the form, so a failed POST looks like success. `handleCreateAsset` does `alert(data.error)` with no fallback → literal "undefined" dialog. | `App.jsx:611-624,1146` |
| 20 | **Invite link goes nowhere**: `${origin}?invite=email` is copied but the query string is never parsed and no email is sent. | `App.jsx:1226,1536` |
| 21 | **Fabricated chat history**: both chat widgets are pre-seeded with invented messages styled as real correspondence; not persisted, reappears on every reload. | `App.jsx:562,1106` |
| 22 | **`socket.off('receive_message')` with no handler** detaches *all* listeners for that event on the shared module-level socket. | `App.jsx:591,1126` |
| 23 | **Attachments base64-inlined into `db.json`**, which is rewritten in full (synchronous `writeFileSync`) on every chat message: 10 messages grew it 490 KB; one small screenshot added 196 KB that is re-sent to every client on every `GET /api/tickets`. | `server.js:70-72,113`, `App.jsx:600-609` |
| 24 | **No 404 handler / error middleware**: `GET /api/nope` → HTML 404 that the frontend's `res.json()` chokes on. Issued reset codes live only in memory, so any restart voids them. Duplicate serial numbers accepted. **PARTIAL:** `DELETE` on a missing user/asset id is now 404; OTP compared as strings so a JSON-number code is accepted. | `server.js` |

## OPEN — dead code & repo hygiene

| # | Finding |
|---|---|
| 25 | **Three backend modules cannot load**: `models/user.js` is a syntax error (bare Mongoose fragment); `controllers/authController.js` + `routes/authRoutes.js` `require('../models/User')` (wrong case → fails on Linux) and would call `sendOtpEmail` as a function when the module exports `{ sendOtpEmail, isSmtpConfigured }`. None are mounted in `server.js`. |
| 26 | **`frontend/src/const express = require('express');.js`** — a complete second SQLite backend (247 lines) committed inside `frontend/src/` under a filename that is a line of code. |
| 27 | **`frontend/src/assets/Appbackup.jsx`** (966 lines, UTF-8 BOM) and `frontend/src/pages/{AuthScreen,ForgotPassword}.jsx` are imported by nothing — except #12, which *should* use ForgotPassword.jsx. |
| 28 | **`backend/helpdesk.db`** — orphaned 28 KB SQLite binary in git; `sqlite3` is not a dependency of anything. |
| 29 | **`frontend/frontend.env.txt`** committed; renaming it to `.env` sets `VITE_API_URL=http://localhost:5000`, which breaks every proxied/preview deployment (the browser can't reach the server's localhost). The `''` default in `App.jsx:9` is correct. |
| 30 | **Server-only packages in frontend deps** (`nodemailer`, `socket.io`); **`tailwind.config.js`** is CommonJS in a `"type":"module"` package and ignored by Tailwind v4; `postcss`/`autoprefixer` unused; **`index.html` title is "frontend"**; **no tests/CI** (`npm test` exits 1 by design). |
| 31 | **`oxlint` runs clean-ish but never enables `no-undef`** — which is exactly why finding #1 shipped. Verified: adding `"env": {"browser": true}` + `"rules": {"no-undef": "error"}` to `frontend/.oxlintrc.json` reports the three offending lines as errors. Wiring `npm run lint` into CI is the cheapest guard against this class of bug. |

## Suggested order for the remaining work

1. ~~**#4 + #6 + #5**~~ — **DONE** (plus #13, #14, #16; partials on #11, #17, #24). Remaining: purge `db.json` from main's history (see FIXED §5).
2. ~~**#12**~~ — **DONE** (see FIXED §12).
3. **#7, #8** — rate limiting and an allow-list of patchable fields.
4. Then the remaining functional and hygiene items; #25-#28 are pure deletions.
