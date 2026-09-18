# SayedFarms Helpdesk — Bug Report & Fix Log

**Branch:** `arena/01a0af05-sayedfarms-helpdesk` · **Base:** PR #6 head (`2770f8a`)

Everything below was **reproduced**, not guessed:

- REST + Socket.IO black-box suites against the live backend (78 checks, 54 failing at diagnosis time)
- The real `App.jsx` rendered in jsdom (fresh DOM per scenario) driven by simulated clicks/keystrokes
- An AST scope analysis (acorn + acorn-jsx) of every JSX file
- `node --check` on every backend file, `vite build`, and `oxlint`

Status legend: **FIXED** = fixed in this branch and regression-tested · **OPEN** = diagnosed, not yet fixed · **PARTIAL** = the worst of it is fixed, work remains.

---

## FIXED

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

### 4. No authentication or authorization anywhere — FIXED
`backend/server.js` now issues real signed JWTs (`jsonwebtoken`, 12 h expiry, `JWT_SECRET` from env —
refuses to boot in production without one) and verifies them in `requireAuth` / `requireAgent`
middleware on every non-public endpoint. Passwords are bcrypt hashes (`bcryptjs`, 10 rounds) with a
boot-time migration that hashes any plaintext leftovers in place. Role is looked up fresh from the DB
on each request, so demotions and deletions take effect immediately. Every attack in the original
evidence row now fails closed: anonymous `GET /api/users`, user delete/promote, asset destroy,
ticket close/reassign, and posting as `"Fake IT Admin"` return 401/403 (sender identity for chat is
derived from the verified session on both REST and sockets). Socket.IO carries the session token in
`socket.handshake.auth`; unauthenticated emits and ticket-room joins for tickets you don't own are
ignored. CORS is allow-listable via `CORS_ORIGIN`.

Also fixed along the way: **#13** (employees' `GET /api/tickets` is server-side scoped to their own;
agents see all), **#14** (`created_by` id + `created_by_name` stamped from the session, legacy tickets
backfilled by reporter name), **#16** (signup/login/forgot-password all compare normalised emails).

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

### 7. Password reset / login brute-forceable + mass assignment — FIXED (step 3)
**#7 Rate limiting.** A tiny in-memory sliding-window limiter (no new deps) now sits in front of the
dangerous endpoints, keyed sensibly per surface:

| surface | limit | key |
|---|---|---|
| `login`, `forgot-password`, `resend-otp`, `reset-password` | 10 / 15 min | IP + normalised email |
| user/asset deletes | 30 / 15 min | IP |
| all other writes (signup, ticket/asset PATCH/POST, chat) | 60 / min | IP |
| socket chat emits | 20 msgs / 10 s | connection |

429 responses carry `X-RateLimit-Limit/Remaining/Reset` and a `retryAfter` hint. Buckets are GC'd so
they can't grow forever. Verified: the 11th bad password in a row returns 429, not 400 ×200.

**#8 Mass assignment.** `Object.assign(record, req.body)` is gone from the codebase. Every POST/PATCH
reads its body through `pick(body, [allowed fields])`: ticket patches can only touch
`title/description/category/priority/status/assigned_to/image`; user patches only `role/name`;
inventory only `name/category/serial_number/assigned_to/status`. `id`, `password`, `created_by`,
`created_by_name`, `messages` can never be overwritten from a client. Verified: `PATCH /api/tickets/101`
with `{"id":"hijacked"}` leaves the id intact (previously it orphaned the record). Employees can no
longer set `assigned_to` on ticket creation either.

### 8. Dead, broken and orphaned code removed — FIXED (step 4a)
- `backend/controllers/authController.js`, `backend/routes/authRoutes.js`, `backend/models/user.js`
  (#25): never mounted, wrong-case `require('../models/User')`, called `sendOtpEmail` as a function
  while the module exports `{ sendOtpEmail, isSmtpConfigured }`, and `models/user.js` was a bare
  Mongoose fragment (syntax error). Deleted.
- `frontend/src/const express = require('express');.js` (#26): a 247-line second SQLite backend
  committed inside `frontend/src/` under a filename that is a line of code. Deleted.
- `frontend/src/assets/Appbackup.jsx` (#27): 966-line UTF-8-BOM backup imported by nothing. Deleted.
- `backend/helpdesk.db` (#28): orphaned 28 KB SQLite binary; `sqlite3` was never a dependency. Deleted.
- `frontend/frontend.env.txt` (#29): setting it as `.env` pointed the browser at the server's
  localhost, breaking every proxied/preview deployment. Deleted (the `''` default in `App.jsx` is correct).
- Frontend deps (#30): server-only `nodemailer` and `socket.io` removed (`socket.io-client` is what
  the browser imports); unused `autoprefixer`/`postcss` removed; stale CJS `tailwind.config.js`
  (ignored by Tailwind v4) deleted; `index.html` title changed from "frontend" to "SayedFarms Help Desk".
- `.oxlintrc.json` (#31) now enables `no-undef` with `env: { browser: true }` — the exact rule that
  would have caught finding #1 — and lint still reports 0 errors.

### 9. Frontend "honesty" fixes — FIXED (step 4b)
- **#19** `handleCreateTicket` never checked `res.ok` — a failed POST closed the modal, wiped the form
  and looked like success. It now shows the server's error inside the modal, keeps the draft and the
  modal open, and catches network errors. `handleCreateAsset`'s `alert(data.error)` rendered a literal
  "undefined" dialog on non-JSON bodies; it now falls back to a real message.
- **#20** The invite link went nowhere: `${origin}?invite=email` was copied but never parsed. The
  auth screen now honours it — switches to signup, pre-fills the invited email, shows an
  "invited by" banner; plain logins are unaffected.
- **#21** Fabricated chat history removed: both chat widgets seeded invented messages styled as real
  correspondence and replayed them on every reload. Both start empty now, with an honest empty-state hint.
- **#22** `socket.off('receive_message')` with no handler detached **every** component's listener on
  the shared module-level socket (mounting the console silently killed the portal's chat and vice
  versa). Both widgets now register/unregister a named handler.
- Also fixed a step-3 regression found during verification: the server's category allow-list had
  `Account` while the form offers `Access/Security` (used by 4 portal cards), silently coercing those
  tickets to `Hardware`. Validator now matches the form.

Verified in jsdom (fresh DOM per scenario, 15/15 checks green): invite prefill + banner, plain login
unaffected, chat opens empty with hint, no fabricated greeting, portal's listener registered and
unmount removes only its own while a foreign listener survives, failed create shows the inline error,
modal stays open and the draft is preserved.

### 10. Input validation + id collisions + JSON 404s — FIXED (step 3, with #8)
- **#15** Empty/garbage bodies now fail with 400: title/description required on tickets (length caps
  on title/name/password), asset `name/category/serial_number` required, enum validation for ticket
  status/priority/category, user role, inventory status. `1-character passwords` were already rejected
  in step 1; signup now also caps name/password length.
- **#18** `Date.now()` primary keys collided under concurrency (6 concurrent signups → 5 unique ids;
  `DELETE` used `filter` so a collision deleted both accounts). All ids now come from a monotonic
  `genId(prefix)` (ms timestamp + always-advancing counter).
- **#24 (most)** `GET /api/nope` returns JSON 404 (was an HTML page the frontend's `res.json()`
  choked on); a JSON error middleware ensures thrown errors never leak stack traces; duplicate asset
  serial numbers are rejected on create and update; OTP codes are compared as strings; missing
  user/asset/ticket ids return 404. *Still open:* reset codes live in memory only.
- **#10** Account enumeration: `forgot-password`/`resend-otp` return the same generic response
  whether the email exists or not (when SMTP is configured), and `reset-password` no longer 404s on
  unknown emails. Login was already uniform.

### 12. Forgot-password is a dead end as shipped — FIXED
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
| 7 | ~~Password reset / login are brute-forceable~~ — **FIXED**, see FIXED §7 (in-memory limiter; put a reverse-proxy limiter in front for multi-instance deployments). | — |
| 8 | ~~Mass assignment~~ — **FIXED**, see FIXED §7 (`pick()` allow-lists everywhere). | — |
| 9 | **Global chat broadcasts to every connected client and persists nothing.** PARTIAL: per-ticket chat is persisted and room-scoped (§4); the global "live chat" widget is still an ephemeral broadcast by design — now only reachable by verified sessions and rate-limited, but conversations are not stored. Decide: persist + scope it, or remove the widget. | `server.js` `send_message` |
| 10 | ~~Account enumeration on forgot-password~~ — **FIXED**, see FIXED §10. | — |
| 11 | **Default admin credentials hard-coded and re-seeded on every boot**. PARTIAL: seed is env-overridable (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, bcrypt-hashed) and only fires when *no* agent exists; the documented dev default remains for local first boot. | `server.js` ensure-admin block |

## OPEN — functional

| # | Finding | Evidence |
|---|---|---|
| 12 | ~~Forgot-password is a dead end as shipped~~ — **FIXED**, see FIXED §12. | — |
| 13 | ~~No per-user ticket scoping~~ — **FIXED** with §4 (server-side scoping; employees see own tickets only). | — |
| 14 | ~~Reporter identity lost~~ — **FIXED** with §4 (`created_by` + `created_by_name` from session; legacy backfilled). | — |
| 15 | ~~No input validation~~ — **FIXED**, see FIXED §10 (required fields, enums, length caps). | — |
| 16 | ~~Duplicate-email guard bypassable by case~~ — **FIXED** with §4 (all comparisons normalised; signup rejects case variants). | — |
| 17 | **Assignments still keyed by display name**, not id: renaming a user orphans every ticket/asset assignment; duplicate names are indistinguishable. PARTIAL: deleting a user re-homes their assignments to `Unassigned` (by id or name); id-keyed assignments still open. | `server.js` PATCH user |
| 18 | ~~`Date.now()` primary keys collide~~ — **FIXED**, see FIXED §10 (monotonic `genId`). | — |
| 19 | ~~Ticket creation swallows failures~~ — **FIXED**, see FIXED §9. | — |
| 20 | ~~Invite link goes nowhere~~ — **FIXED**, see FIXED §9. | — |
| 21 | ~~Fabricated chat history~~ — **FIXED**, see FIXED §9. | — |
| 22 | ~~`socket.off` with no handler detaches all listeners~~ — **FIXED**, see FIXED §9. | — |
| 23 | **Attachments base64-inlined into `db.json`**, which is rewritten in full on every chat message. PARTIAL: new ticket images are capped (~2 MB) so the worst bloat is bounded; the inline-base64 storage design remains. Move attachments to files/object storage with a size limit. | `server.js`, `App.jsx` |
| 24 | **Fragments remaining**: reset codes live only in memory, so any restart voids them (move to the DB or accept the UX). Everything else in the original finding is fixed — JSON 404s, error middleware, duplicate serial rejection, string OTP compare. | `otpStore` |

## OPEN — repo hygiene

| # | Finding |
|---|---|
| 25–29 | ~~Dead/broken/orphaned files~~ — **FIXED**, see FIXED §8 (all deleted). |
| 30 | ~~Server-only deps, dead tailwind config, "frontend" title~~ — **FIXED** (§8). **Remaining:** there is still no test suite / CI wiring (`npm test` is a stub). |
| 31 | ~~`no-undef` never enabled~~ — **FIXED** (§8: enabled with `browser:true`, 0 errors). **Remaining:** no CI job runs the linter/build yet. |

## Suggested order for the remaining work

1. ~~#4 + #6 + #5~~ — **DONE** (plus #13, #14, #16; partials on #11, #17, #24). Remaining: purge `db.json` from main's history (see FIXED §5).
2. ~~#12~~ — **DONE** (see FIXED §12).
3. ~~#7, #8~~ — **DONE** (plus #15, #18, #10, most of #24; see FIXED §7/§10).
4. ~~Remaining functional + hygiene~~ — **DONE** for #19–#22, #25–#29, #30/#31 cleanups (see FIXED §8/§9). Still open: #9 (global chat design), #11 (admin seed policy), #17 (id-keyed assignments), #23 (attachment storage), #24 (persist reset codes), test/CI wiring, and the history purge from #5.
