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

---

## OPEN — security (fix before any real deployment)

| # | Finding | Evidence |
|---|---|---|
| 4 | **No authentication or authorization anywhere.** Login returns `'mock-jwt-token-'+id` and nothing validates it; `jsonwebtoken`/`bcryptjs` are installed but unused. Anonymous curl listed all users, deleted an account, destroyed an asset, promoted a user to agent, closed/reassigned tickets, and posted into a ticket thread as `"Fake IT Admin"`. `app.use(cors())` + socket.io `origin:'*'` make it drivable from any website. | `server.js:10,16,182,191,236-345` |
| 5 | **Plaintext passwords committed to git.** `backend/db.json` is tracked and contains live-looking accounts with readable passwords (`…@sayedfarms.com` / `"aa"`). `.gitignore` covers `.env` but not `db.json`. Rotate these credentials and purge the file from history. | `backend/db.json`, `server.js:187` |
| 6 | **Anyone can self-register as an IT Agent.** `role` is taken from the signup request body, and the public signup form offers "IT Staff (Agent Console)" in a dropdown. | `server.js:179`, `App.jsx:429-432` |
| 7 | **Password reset / login are brute-forceable.** 200 wrong OTPs → all HTTP 400, no lockout or delay (10⁶ keyspace, 10-minute validity); 40 wrong admin passwords → all HTTP 400. No rate limiter installed. | `server.js:224-227` |
| 8 | **Mass assignment.** `Object.assign(ticket, req.body)` let a client rewrite a ticket's primary key to `"hijacked"`, orphaning the record; same pattern on inventory. | `server.js:292,336` |
| 9 | **Live chat broadcasts every conversation to every connected client** (`io.emit`), and nothing is persisted. | `server.js:349` |
| 10 | **Account enumeration** on forgot-password (404 vs 200). | `server.js:137` |
| 11 | **Default admin credentials hard-coded and re-seeded on every boot** (`admin@sayedfarms.com` / `Admin@12345`), even if deleted. | `server.js:77-88` |

## OPEN — functional

| # | Finding | Evidence |
|---|---|---|
| 12 | **Forgot-password is a dead end as shipped.** With no `backend/.env` the backend honestly returns `emailSent:false` + `devOtp`, but the live UI reads neither and always says "Verification code sent! Check your inbox." The README promises the opposite, and a correct implementation already exists in the **unused** `src/pages/ForgotPassword.jsx`. Wire that component up and delete the inline duplicate. | `App.jsx:208-231` vs `src/pages/ForgotPassword.jsx` |
| 13 | **No per-user ticket scoping.** "My Submitted Requests" lists every ticket in the system with working Cancel buttons; one employee rendered all 38. | `server.js:266`, `App.jsx:677-678` |
| 14 | **Reporter identity lost** — every ticket is stamped `created_by_name: "User"` and no `created_by` field exists. | `server.js:280` |
| 15 | **No input validation**: empty signup/ticket/asset bodies all return 200; 1-character passwords accepted on signup and reset. | `server.js:174-183,270-287,318-331` |
| 16 | **Duplicate-email guard bypassable by case**: signup compares raw, login compares normalised → two live accounts for one address (the second took `role:"agent"` in testing). | `server.js:176` vs `:187` |
| 17 | **Assignments keyed by display name**, not id: renaming a user orphans every ticket/asset assignment; duplicate names are indistinguishable. Deleting a user strands their tickets/assets with a blank `<select>`. | `server.js:279`, `App.jsx:1357,1404` |
| 18 | **`Date.now()` primary keys collide** (6 concurrent signups → 5 unique ids); `DELETE /api/users/:id` uses `filter`, so a collision deletes both accounts. | `server.js:179,241,273,321` |
| 19 | **Ticket creation swallows failures** — `handleCreateTicket` never checks `res.ok`, then closes the modal and clears the form, so a failed POST looks like success. `handleCreateAsset` does `alert(data.error)` with no fallback → literal "undefined" dialog. | `App.jsx:611-624,1146` |
| 20 | **Invite link goes nowhere**: `${origin}?invite=email` is copied but the query string is never parsed and no email is sent. | `App.jsx:1226,1536` |
| 21 | **Fabricated chat history**: both chat widgets are pre-seeded with invented messages styled as real correspondence; not persisted, reappears on every reload. | `App.jsx:562,1106` |
| 22 | **`socket.off('receive_message')` with no handler** detaches *all* listeners for that event on the shared module-level socket. | `App.jsx:591,1126` |
| 23 | **Attachments base64-inlined into `db.json`**, which is rewritten in full (synchronous `writeFileSync`) on every chat message: 10 messages grew it 490 KB; one small screenshot added 196 KB that is re-sent to every client on every `GET /api/tickets`. | `server.js:70-72,113`, `App.jsx:600-609` |
| 24 | **No 404 handler / error middleware**: `GET /api/nope` → HTML 404 that the frontend's `res.json()` chokes on. Issued reset codes live only in memory, so any restart voids them. Duplicate serial numbers accepted; `DELETE` on a missing id reports success; OTP compared with `!==` so a JSON-number code is rejected. | `server.js` |

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

1. **#4 + #6 + #5** — real JWT verification and `bcryptjs` hashing (both already in `package.json`),
   `requireAuth`/`requireAgent` middleware, server-side ticket scoping, reject `role` from signup,
   rotate the leaked passwords and purge `db.json` from history.
2. **#12** — route `/forgot-password` to the existing `src/pages/ForgotPassword.jsx`.
3. **#7, #8** — rate limiting and an allow-list of patchable fields.
4. Then the remaining functional and hygiene items; #25-#28 are pure deletions.
