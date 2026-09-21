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

## MTTR — mean time to resolution

Tickets carry the stamps the reports aggregate (all set by the server, never
by a client):

| Field | Meaning |
|---|---|
| `created_at` | when the request was raised (start of the clock) |
| `first_response_at` | the first reply posted by an IT agent (stamped once) |
| `resolved_at` | when the ticket reached **Resolved** (or **Closed** directly); re-stamped when a reopened ticket is resolved again |
| `closed_at` | when the ticket reached **Closed** |
| `resolution_minutes` | `resolved_at − created_at` in minutes — total elapsed time to resolution, reopens included |
| `reopened_count` | how many times work resumed after a resolution |

Status transitions keep the stamps honest: **Resolved ↔ Closed** keeps the
original resolve time; leaving a resolution state for active work counts a
**reopen** and the next cycle is measured fresh; **Cancelled** abandons the
resolution (stamps cleared, not counted as a reopen). Tickets that were
already resolved before these stamps existed keep `null` timestamps and are
excluded from the report rather than estimated.

`GET /api/reports/mttr?days=7|30|90|365|all` (IT agents only; default 30)
returns the dashboard feed: summary (mean / median / fastest / slowest,
first-reply average, reopen count), a trend of mean-resolution time per day /
week / month, breakdowns by category, priority and agent, and the slowest
resolved tickets. Scoping follows the queue rules exactly — a super admin's
report covers every ticket, a regular agent's only the tickets assigned to
them (`scope: "all" | "own"`). The Agent Console shows it under **MTTR
Reports**, and ticket tables display "Resolved in …" / "Reopened ×n" per row.

## Locked out of the super admin account?

Passwords are stored as bcrypt hashes, so **nobody can read a password back out
of `db.json`** — not you, not this project. Access is restored instead:

```bash
cd backend
npm run accounts                      # who exists, and who is the super admin
node scripts/admin.js admin@sayedfarms.com --password 'a-new-strong-password'
npm start                             # restart: accounts are loaded at boot
```

- `npm run accounts` (`node scripts/admin.js --list`) prints every account, its
  role and whether it holds super-admin access — never a password hash.
- Reset one account and it is granted IT agent + super admin; add `--agent` to
  grant the queue-scoped agent role instead.
- Omit `--password` and a strong random one is generated and shown once.
- The tool refuses to leave the installation with **zero** super admins.
- Point it elsewhere with `--file <path>` (or the `DATA_FILE` env var).

**Stop the server first.** It keeps the whole database in memory and rewrites
`db.json` on every write, so a change made while it is running can be silently
overwritten. Restart it afterwards.

Forgot-password also works without SMTP: with no SMTP configured the reset code
is printed to the backend terminal and shown on screen (development only).

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
  and category dropdowns from `GET /api/meta/enums`, so the UI can't offer a
  value the API rejects (or one it quietly rewrites). Asset categories are
  server-owned (`inventoryCategory`): Laptop, Desktop Computer, Monitor,
  Printer, Cartridge, Toner, IP Camera, Solar PTZ Camera, NVR, SSD/HDD,
  Network Equipment, Peripherals, Server, UPS, Other — the Add Asset form and
  the inventory table both pick from this list, and an unknown value is
  rejected with `400` (never silently stored). Legacy rows marked `Desktop`
  are migrated to `Desktop Computer` on boot.
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

> **Security: two credential files are still readable in this repository's
> history. Rotate them — that is the only fix that protects you.**
>
> Both were verified against the live GitHub API, not inferred:
>
> | File | What it contains | Status |
> |---|---|---|
> | `backend/db.json` | plaintext passwords for `admin@sayedfarms.com`, `ishaq.tesleem@sayedfarms.com`, `aa@sayedfarms.com`, `ishaqtesleem@gmail.com` | **fetchable by commit SHA** (`9767591`) |
> | `frontend/di-rect password.txt` | plaintext credentials for `admin`, `remote`, `Alaba-Links` | **fetchable by commit SHA** (`9767591`) |
>
> Deleting the branches that contained them does **not** unpublish them:
> commit `9767591` stays reachable through GitHub's pull-request refs
> (`refs/pull/1..8/head`), which cannot be deleted by users. Browsing the repo
> returns 404, but `GET /repos/:owner/:repo/contents/<path>?ref=9767591` still
> serves both files.
>
> To close it:
> 1. **Rotate every credential above** wherever it is used (the helpdesk
>    accounts *and* the `admin`/`remote`/`Alaba-Links` logins), then change the
>    passwords in the app — `npm run accounts` lists the accounts, and
>    `node scripts/admin.js <email> --password <new>` resets one.
> 2. **Ask GitHub Support to purge commit `9767591`** ("sensitive data
>    removal"). Only Support can expire the PR refs and cached objects.
> 3. Optional and incomplete: `git filter-repo --path backend/db.json --path
>    'frontend/di-rect password.txt' --invert-paths` then force-push. It rewrites
>    every branch SHA (breaking clones and open PRs) and *still* leaves the PR
>    refs intact, so do 1 and 2 regardless.

## Password reset emails (SMTP)

The "Forgot Password" flow emails a 6-digit code to the user. Emails are
**only delivered when SMTP is configured** in `backend/.env`
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, optional `MAIL_FROM`).
See `backend/.env.example` for Office 365 / Gmail settings.

If SMTP is not configured, the app says so on screen and (outside
`NODE_ENV=production`) shows the reset code directly in the page instead of
silently pretending an email was sent.
