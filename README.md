# sayedfarms-helpdesk
SayedFarms IT helpdesk OS

## Running locally

**Backend** (port 5000):

```bash
cd backend
npm install
cp .env.example .env   # then edit .env with real SMTP + auth settings
npm start
```

**Frontend** (port 5173, proxies `/api` and `/socket.io` to the backend):

```bash
cd frontend
npm install
npm run dev
```

On first boot the backend creates `backend/db.json` (git-ignored, local-only)
with seed data plus an admin account, and prints the credentials it used.
Default admin sign-in (development only — override via `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `backend/.env`):

- email: `admin@sayedfarms.com`
- password: `Admin@12345`

## Authentication & roles

- Passwords are stored as bcrypt hashes; sessions are signed JWTs
  (`Authorization: Bearer <token>`, 12-hour expiry by default).
- **Every public signup creates an employee account.** There is no way to
  self-register as an agent or a super admin: those are granted from User
  Management in the Agent Console.

### Who sees which ticket

| Account | Ticket queue | Can reassign |
|---|---|---|
| Employee | only the tickets they raised | no |
| **Agent** | **only the tickets assigned to them** | no |
| **Super admin** | every ticket (plus the unassigned dispatch queue) | **yes** |

- An agent can work their own tickets (status, details, per-ticket chat) and
  nothing else — another agent's ticket is a `403` on read, edit *and* chat,
  and its live chat traffic is never delivered to their socket.
- The **super admin** dispatches: only that role can move a ticket between
  agents, hand it back to the unassigned pool, or manage user accounts. The
  queue and any open thread update live when work is reassigned.
- `super_admin` is a flag on an agent account (`safeUser().super_admin`), so
  every `role === 'agent'` rule keeps working. Promotion/demotion lives in
  User Management → *Ticket Access*; the **last** super admin cannot be
  demoted, so a queue can never become unassignable.
- On first boot after upgrading, existing agent accounts become regular
  agents and the `ADMIN_EMAIL` account (or, failing that, the first agent) is
  promoted to super admin — the boot log says which.
- Employees only ever see their own tickets (list, updates, chat). The user
  directory is super-admin-only; everyone else uses the id/name agent picker
  (`GET /api/agents`) for the "direct request" dropdown — picking an agent
  there really does assign them. Agents keep an email-free `{id,name,role}`
  directory (`GET /api/people`) for assigning assets.
- **Assignments are keyed by user id.** Tickets and assets carry
  `assigned_to_id` (canonical) plus `assigned_to` (a denormalized display name
  kept in sync), so renaming a user never orphans their work and two accounts
  with the same name stay distinguishable. Writes accept either field;
  `assigned_to_id` wins. Legacy name-only rows are migrated on boot.
- Socket.IO chat carries the session token (`socket.auth = { token }`);
  emits from unauthenticated sockets and ticket-room joins for tickets you
  don't own are ignored.

## Tests & CI

```bash
cd backend && npm test     # boots the real server on a scratch db.json and drives the API
cd frontend && npm run lint && npm run build
```

`backend/tests/api.test.js` covers the authz guards, the UI/API status contracts,
id-keyed assignments (rename/duplicate-name/delete/legacy migration), per-agent
queue scoping and super-admin dispatch (including live socket delivery), the
persisted reset codes and the rate limiter. `.github/workflows/ci.yml` runs all
of it on every push and pull request.

Set `DATA_FILE` to point the server at a different store, and
`RATE_LIMIT_SCALE` to raise (never disable) every rate-limit budget — useful in
tests, or behind a reverse proxy that already limits traffic.

## Hardening notes

- **Rate limits (in-memory):** sign-in / password-reset endpoints allow
  10 attempts per 15 minutes per IP+email; destructive endpoints 30/15 min;
  general writes 60/min; socket chat 20 messages / 10 s per connection.
  Exceeding a limit returns `429` with `X-RateLimit-*` headers. For
  multi-instance deployments, put a shared limiter (e.g. at the reverse
  proxy) in front — these counters are per-process.
- **Field allow-lists:** every POST/PATCH only accepts known fields
  (`id`, `password`, `created_by` etc. can never be rewritten by a client),
  and enums (ticket status/priority/category, user role, asset status) are
  validated server-side. An unknown value is rejected with `400` — it is never
  silently replaced by a default.
- **One source of truth for dropdown values:** the frontend renders its status
  dropdowns from `GET /api/meta/enums`, so the UI can't offer a value the API
  rejects (or one it quietly rewrites).
- **Password-reset codes** are persisted in `db.json` as SHA-256 digests
  (never plaintext), expire after 10 minutes, and are burned after 5 wrong
  attempts. They survive server restarts.
- The global "Live IT Chat" widget is an ephemeral, all-agents broadcast —
  nothing is stored. Use a ticket's per-ticket chat for a persisted,
  room-scoped conversation.
- `backend/db.json` is the local data store (auto-seeded on first boot,
  git-ignored). Attachments are currently stored inline as base64 with a
  ~2 MB cap — move them to file/object storage before real scale.

Required env (see `backend/.env.example`): `JWT_SECRET` (the server refuses
to boot in production without it), `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`CORS_ORIGIN`, `JWT_EXPIRES_IN`.

> **Note:** `backend/db.json` was tracked in git in an early commit and
> contained plaintext passwords. It is now git-ignored and no longer
> committed, but the old values live on in history — treat every password
> that was ever committed there as compromised, rotate them, and purge the
> file from history (e.g. `git filter-repo --path backend/db.json
> --invert-paths`) before any real deployment.

## Password reset emails (SMTP)

The "Forgot Password" flow emails a 6-digit code to the user. Emails are
**only delivered when SMTP is configured** in `backend/.env`
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, optional `MAIL_FROM`).
See `backend/.env.example` for Office 365 / Gmail settings.

If SMTP is not configured, the app says so on screen and (outside
`NODE_ENV=production`) shows the reset code directly in the page instead of
silently pretending an email was sent.
