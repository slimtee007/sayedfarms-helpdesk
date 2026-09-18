# SayedFarms Helpdesk — Bug Report & Fix Log

**Branch:** `arena/01a0b4da-sayedfarms-helpdesk` · **Base:** `main` (`eec876a`, PR #8 merged)

> **Step 5 (this branch):** UI ↔ API contract drift + assignment integrity. Items **#17** and **#24**
> are now fixed, and four new findings (#32–#35) — all reproduced against the running server — are
> fixed with them. A regression suite (`backend/tests/api.test.js`, 14 tests) and a CI workflow now
> guard the behaviours that broke. See [FIXED §13](#13-ui--api-contract-drift--assignment-integrity--fixed-step-5).

Everything below was **reproduced**, not guessed:

- REST + Socket.IO black-box suites against the live backend (78 checks, 54 failing at diagnosis time)
- Live end-to-end suites re-run after each step (69 checks across steps 5–6, through the Vite proxy)
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

### 13. UI ↔ API contract drift + assignment integrity — FIXED (step 5)

Every finding below was reproduced against the running server before being fixed, and each has a
regression test in `backend/tests/api.test.js`.

#### #32. The Agent Console offered two ticket statuses the API rejected — FIXED
The status `<select>` offers **`Pending / On Hold`** and **`Closed`**; `VALID_TICKET_STATUS` was
`['Open', 'In Progress', 'Resolved', 'Cancelled']`. Picking either one returned
`400 {"error":"Status must be one of: Open, In Progress, Resolved, Cancelled"}`, so a ticket could
never actually be parked or closed — even though the badge colours and the `Pending` filter already
existed on the employee side.

```
PATCH /api/tickets/:id {"status":"Pending"}  ->  400   (was)
PATCH /api/tickets/:id {"status":"Closed"}   ->  400   (was)
```

Fixed: the enum now covers every value the UI can produce, and `GET /api/meta/enums` publishes the
lists so the frontend renders its dropdowns from the server's own source of truth. `Pending` and
`Closed` are accepted and stored verbatim.

#### #33. Asset status was *silently* rewritten to "In Stock" — FIXED
Worse than a 400. The Add Asset form offers **`Under Maintenance`** and **`Decommissioned`**, and the
create endpoint did:

```js
const status = body.status && VALID_INVENTORY_STATUS.has(body.status) ? body.status : 'In Stock';
```

The validity set was `['In Stock', 'Assigned', 'In Repair', 'Retired']`. So an agent picking
"Under Maintenance" pressed Save, got `200 OK`, and the asset was quietly stored as **In Stock** —
wrong data, no error, no hint. Editing an existing asset to either value failed outright with a 400
(`Status must be one of: In Stock, Assigned, In Repair, Retired`).

Fixed: one canonical set covering both forms' options (the union), the create path now **rejects**
an unknown status with a 400 instead of silently substituting one, and both asset dropdowns render
from `/api/meta/enums` — which also makes `In Repair` / `Retired` reachable from the Add Asset form
(it previously couldn't produce them).

#### #34. "Direct Request to Agent" was silently ignored for employees — FIXED
The employee portal's ticket form has a **Direct Request to Agent (Optional)** dropdown listing real
agents with "Any Available IT Agent" as the default. The backend threw the choice away:

```js
const assignedTo = req.user.role === 'agent' && body.assigned_to ? String(body.assigned_to) : 'Unassigned';
```

An employee could pick a specific agent, submit, and get an "Unassigned" ticket with no feedback.
Fixed: the request is honoured for everyone, but the target must be a real IT agent (or Unassigned) —
employees still cannot assign a ticket to an arbitrary user or invent a name, and an unknown assignee
now returns a clear 400 instead of being discarded.

#### #35. Failed agent actions were invisible (silent revert) — FIXED
`handleAgentUpdate`, `handleUpdateAsset`, `handleDeleteAsset`, `handleDeleteUser` and
`handleCancelTicket` never looked at the response. Combined with the 400s above, the UI *looked*
like it worked: the control changed, the refetch restored the old value, and the agent was told
nothing. All five now surface the server's message (`alert` / inline error). The attachment input
also warned nothing when a file exceeded the server's ~2 MB cap — it is now rejected up front with
the actual size and limit.

#### #17. Assignments are now keyed by user id — FIXED
Assignments were stored as the assignee's **display name**, so renaming a user orphaned every ticket
and asset pointing at them, and two accounts sharing a name were indistinguishable (the assignee
`<select>` emitted duplicate React keys and two identical option values — you could not pick one of
them).

- `assigned_to_id` is now the source of truth; `assigned_to` is kept as a denormalized display name
  so existing consumers keep working. Legacy name-only rows are migrated on boot (verified: the
  migration is persisted, and an unresolvable name is preserved rather than relabelled "Unassigned").
- Writes accept `assigned_to_id` (preferred) or `assigned_to` (legacy), and the frontend sends ids.
- Renaming a user refreshes the denormalized names; deleting a user clears the id and returns their
  assets to `In Stock`; tickets may only be assigned to IT agents.

#### #24. Password-reset codes survive a restart — FIXED
Codes lived in a plain in-memory object, so any restart (deploy, crash, free-tier cycle) voided the
code the user had just been emailed — which reads as "the code you sent me is wrong". They now live
in `db.json` under `resetCodes`, stored as a **SHA-256 digest** rather than plaintext, with expired
entries pruned on boot and a **5-attempt cap** (`Too many incorrect codes. Request a new one.`) so
the 6-digit space can't be walked inside the 10-minute window. Verified on the live server: a code
issued *before* a restart still reset the password *after* it.

#### Supporting changes
- `GET /api/meta/enums` (authenticated) publishes status/priority/category/role lists; the frontend
  falls back to built-in defaults if the call fails, so a partial response can never blank a dropdown.
- `DATA_FILE` env override, so tests (and multi-instance deployments) don't touch the real store.
- `RATE_LIMIT_SCALE` env multiplier (default `1`): the limiter stays on, but a test suite driving the
  whole API from one IP can raise the budget instead of disabling it.
- `backend/tests/api.test.js` — 14 tests (authz guards, statuses, assignments/rename/delete, legacy
  migration, reset-code persistence + burn, rate-limit 429s, JSON 404s) run by `npm test`.
- `.github/workflows/ci.yml` — runs the tests, the linter and the production build on every push/PR.

**Verified:** `npm test` → 14/14 pass · `oxlint` → 0 errors (warnings 16 → 14) · `vite build` → clean ·
34/34 live end-to-end checks through the Vite dev proxy, plus a real server restart mid-reset-flow.

### 14. Every agent could see and edit every ticket — FIXED (step 6)

> Requested feature: *"I only want each agent to see tickets assigned to them; a super admin should see
> all tickets and be able to reassign them."* Verified first: **neither existed.** Any agent could list
> every ticket, open anyone's thread, and reassign any work to anyone — there was no dispatcher tier at
> all. Both are now implemented and regression-tested (`backend/tests/api.test.js`).

#### What was wrong
`GET /api/tickets` returned `tickets` in full for any `role === 'agent'`, `canAccessTicket()` returned
`true` for every agent, and `PATCH /api/tickets/:id` had no ownership check for agents — so an agent
could read, edit and reassign tickets belonging to other agents, including tickets assigned to nobody
in particular. Reassigning was the *only* way to hand work over, which is why it had been left open.

#### The rules now

| Account | Ticket queue | Reassign |
|---|---|---|
| Employee | only tickets they raised | no |
| Agent | **only tickets assigned to them** | no |
| Super admin | everything + the unassigned dispatch queue | **yes** |

- Scoped at the API, not in the UI: a regular agent's list response simply never contains other
  agents' tickets, and direct access returns `403` on **read, edit and chat**.
- **Live delivery was part of the leak.** Sockets joined every ticket room on connect, so per-ticket
  chat was pushed to every connected agent regardless of ownership. Rooms are now derived from the
  session's own queue, and reassignment re-syncs them — the old owner loses the room, the new owner
  gains it, both without a reload.
- `super_admin` is a flag on an agent account rather than a new role value, so every existing
  `role === 'agent'` rule (JWT payloads, inventory, sockets) kept working untouched.
- The **last super admin cannot be demoted**, and an agent cannot promote themselves (`403`) — the
  dispatch tier can't be removed or seized by accident.
- Existing installs migrate on boot: agent accounts become regular agents and the `ADMIN_EMAIL`
  account (else the first agent) is promoted, with a log line naming it.

#### Frontend
The Agent Console is role-aware: a regular agent gets **"My Assigned Tickets"** (assignee column
read-only), no User Management tab and no dispatch controls; a super admin gets the full queue, the
reassignment dropdown and a *Ticket Access* selector per agent account. Queues and open threads
refresh live over the new `ticket_changed` / `ticket_created` events. Agents keep an email-free
`{id,name,role}` directory (`GET /api/people`) so asset assignment still works without exposing the
account directory.

**Verified:** 20/20 backend tests (6 new for #36, including a real socket-delivery check), `oxlint`
0 errors, `vite build` clean, **35/35 live checks** through the Vite proxy for the new rules and
**34/34** of the previous suite re-run unchanged (no regressions).

### 15. Credentials committed to git — PARTIALLY FIXED (step 7)

While auditing the credential situation, the record in this report needed correcting: the note above
blamed `backend/db.json`, but **that file was never committed** — `git rev-list --all --objects |
grep db.json` returns nothing. What actually leaked is different, and it is still reachable.

| # | Finding | Status |
|---|---|---|
| 37 | **`frontend/di-rect password.txt` was committed with plaintext credentials** (`admin`, `remote`, `Alaba-Links` and their passwords). Deleted in `0cebc46`, but the commit is an ancestor of the still-existing `arena/*` branches, so the contents remain readable on GitHub in a **public** repository. | **File deleted · history NOT purged — rotate now** |
| 38 | Any agent could see, edit and reassign every ticket; no dispatcher tier existed. | **FIXED** — see FIXED §14 (#36) |

**To close #37:** treat every credential in that file as compromised and rotate it at the source
(none of them are helpdesk accounts — they look like unrelated infrastructure logins, so check what
else uses them), then remove it from history and force-push, or delete the stale `arena/*` branches:

```bash
git filter-repo --path 'frontend/di-rect password.txt' --invert-paths
git push --force --all && git push --force --tags
```

GitHub also keeps unreachable objects for a while after a force-push; contact support if the repo was
public and you need them expired immediately. Rotating the credentials is the part that actually
matters — the history purge only stops future readers.

#### Account recovery tooling — ADDED
Because passwords are bcrypt hashes and cannot be read back out of `db.json`, `backend/scripts/admin.js`
now handles "I am locked out" without editing files by hand:

- `npm run accounts` — lists accounts, roles and who holds super-admin access (never a hash).
- `node scripts/admin.js <email> --password <new>` — resets the password and grants IT agent +
  super admin (`--agent` for the queue-scoped role instead, omit `--password` to generate one).
- Refuses to leave the installation with zero super admins, writes atomically, and warns that the
  server must be stopped first (it holds the database in memory and overwrites `db.json` on writes).

**Verified:** 24/24 backend tests (3 new covering the listing, a real locked-out recovery, and the
zero-super-admin guard), plus a manual end-to-end run — reset the super admin password, booted the
server, signed in with the new password, confirmed the old one is rejected and the full ticket queue
is visible.

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
| 17 | ~~Assignments keyed by display name~~ — **FIXED**, see FIXED §13 (canonical `assigned_to_id` + migration, duplicate names distinguishable, renames/deletes handled). | — |
| 18 | ~~`Date.now()` primary keys collide~~ — **FIXED**, see FIXED §10 (monotonic `genId`). | — |
| 19 | ~~Ticket creation swallows failures~~ — **FIXED**, see FIXED §9. | — |
| 20 | ~~Invite link goes nowhere~~ — **FIXED**, see FIXED §9. | — |
| 21 | ~~Fabricated chat history~~ — **FIXED**, see FIXED §9. | — |
| 22 | ~~`socket.off` with no handler detaches all listeners~~ — **FIXED**, see FIXED §9. | — |
| 23 | **Attachments base64-inlined into `db.json`**, which is rewritten in full on every chat message. PARTIAL: new ticket images are capped (~2 MB) so the worst bloat is bounded; the inline-base64 storage design remains. Move attachments to files/object storage with a size limit. | `server.js`, `App.jsx` |
| 24 | ~~Reset codes live only in memory~~ — **FIXED**, see FIXED §13 (persisted in `db.json`, stored as a SHA-256 digest, 5-attempt cap). Everything else in the original finding was already fixed — JSON 404s, error middleware, duplicate serial rejection, string OTP compare. | — |

## OPEN — repo hygiene

| # | Finding |
|---|---|
| 25–29 | ~~Dead/broken/orphaned files~~ — **FIXED**, see FIXED §8 (all deleted). |
| 30 | ~~Server-only deps, dead tailwind config, "frontend" title~~ — **FIXED** (§8). **Tests FIXED in step 5:** `backend/tests/api.test.js` (14 tests, `npm test` boots the real server against a scratch db) and `.github/workflows/ci.yml` runs tests + lint + build on every push/PR. |
| 31 | ~~`no-undef` never enabled~~ — **FIXED** (§8: enabled with `browser:true`, 0 errors). **CI FIXED in step 5:** the workflow runs `npm run lint` and `npm run build` on every push/PR (warnings logged, errors fail the job). |

## Suggested order for the remaining work

1. ~~#4 + #6 + #5~~ — **DONE** (plus #13, #14, #16; partials on #11, #17, #24). Remaining: purge `db.json` from main's history (see FIXED §5).
2. ~~#12~~ — **DONE** (see FIXED §12).
3. ~~#7, #8~~ — **DONE** (plus #15, #18, #10, most of #24; see FIXED §7/§10).
4. ~~Remaining functional + hygiene~~ — **DONE** for #19–#22, #25–#29, #30/#31 cleanups (see FIXED §8/§9).
5. ~~#17 + #24 + test/CI wiring~~ — **DONE** (see FIXED §13), along with four new contract bugs found while
   verifying it (#32–#35). Still open: #9 (global chat design), #11 (admin seed policy), #23 (attachment
   storage), and the `db.json` history purge from #5.
