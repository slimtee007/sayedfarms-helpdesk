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

### Report generation

Every report screen has **Export CSV** and **Print** (browser print → save as
PDF); the exports are also plain authenticated API endpoints:

| Endpoint | Output |
|---|---|
| `GET /api/reports/mttr/export?days=…` | MTTR report CSV — summary block, then one row per resolved ticket behind the numbers (created / first response / resolved / closed stamps, resolution minutes, reopens). Same scoping as the JSON feed. |
| `GET /api/reports/assets` | IT asset stock report — totals, **in stock / low stock / out of stock**, the restock watchlist, per-category split, per-status counts, and the asset rows with quantities. |
| `GET /api/reports/assets/export` | The asset report as CSV — summary block, restock watchlist, category and status splits, then one row per asset with quantity, reorder level and stock state. |
| `GET /api/inventory/low-stock` | The restock watchlist as JSON — store-room lines running out (at/below their reorder level) or already empty, with `lowStock` / `outOfStock` counts. |
| `GET /api/reports/calls?days=…` | The PBX call report JSON — summary (volumes, answered/missed, talk time, solve rate, mean minutes from call to fix), per-extension / per-hour / per-day splits, and one row per call. Same scoping as the call log. |
| `GET /api/reports/calls/export?days=…` | The call report as CSV — summary block, splits, then one row per call with direction, duration, ring time, ticket and solved state. |

### Stock tracking & low-stock alerts

Inventory lines carry two stock fields (both optional, both validated as whole
numbers 0–1,000,000):

- `quantity` — how many are on the store-room shelf. Defaults to `1` (a
  serial-numbered unit is one physical item); consumable lines (toners,
  cartridges, drives…) count higher.
- `reorder_level` — the "reorder at" threshold. `null` (default) disables
  low-stock alerting for that line.

The server derives a three-way **stock state** for every line (never the
client, so the UI, the report and the CSV can never disagree):

| State | Meaning |
|---|---|
| **In Stock** | on the shelf, above its reorder level |
| **Low Stock** | on the shelf but at/below its reorder level — time to reorder |
| **Out of Stock** | shelf empty (`quantity` 0), or not in the store room at all (Assigned, In Repair, Retired, …) |

Running-out detection is the `needs_restock` flag / `GET /api/inventory/low-stock`
watchlist: store-room lines at/below their reorder level or with an empty
shelf. **Deployed, repaired or retired gear is never a restock alert** — it is
just not on the shelf. In the Agent Console the **IT Assets** workspace shows a
count badge and a restock banner, adjusts quantities in place (− / +) and lets
you set the alert level per row; **Asset Reports** adds the low-stock KPI,
watchlist and filter. Legacy rows migrate to `quantity: 1` / no alert level on
boot, and the CSVs are RFC-4180 quoted (Excel-friendly, with a UTF-8 BOM).

## IP-phone calls → tickets (Panasonic PBX / SMDR)

When someone phones the IT office on the office IP-phone, the call is logged
automatically and raises a ticket for the IT team. Every call record keeps the
time the call came in, its direction (incoming / outgoing / internal), the
extension, who rang, how long it rang, how long the call lasted, and whether
the issue was solved.

The PBX is a **Panasonic**, so the feed is its **SMDR** call log (KX-NS / NSX /
TDA / TDE / TD families). Pick whichever wiring matches the site — or leave
`PBX_TRANSPORT=auto` and let the configured addresses decide:

| `PBX_TRANSPORT` | Use it when | How it works |
|---|---|---|
| `tcp-client` | the PBX prints SMDR over the LAN (KX-NS/NSX, port **2300**) | the helpdesk connects to `PBX_HOST:PBX_PORT`, logs in with `PBX_USERNAME` / `PBX_PASSWORD` (`SMDR` / `PCCSMDR` on a factory-fresh PBX) and reads the records |
| `tcp-server` | a serial-to-IP gateway is wired to the PBX's RS-232C SMDR port, or the PBX pushes records | the helpdesk listens on `PBX_LISTEN_HOST:PBX_LISTEN_PORT` and frames whatever arrives as lines |
| `webhook` | existing middleware already relays the SMDR text | anything that can POST text to `/api/pbx/calls` with the `X-PBX-Token` secret |

Records can also be entered by hand (**Log a call**) or produced by the
built-in **Simulate call** button — a development/demo aid that is on outside
production and only with `PBX_ALLOW_SIMULATOR=true` in it. The simulator prints
a real console-shaped record, so the wiring can be proven before the PBX is
connected.

**Which calls raise a ticket.** A call is "for IT" when one of the
`PBX_IT_EXTENSIONS` is involved — either end of an internal call, or the
extension that rang. `PBX_TICKET_POLICY` then decides:

| Policy | Tickets raised for |
|---|---|
| `all` (default) | every IT call — answered, missed, internal or outgoing |
| `answered` | only calls that were answered (talk time above `PBX_MIN_CALL_SECONDS`) |
| `missed` | only calls nobody picked up (ring ≥ `PBX_MIN_RING_SECONDS`) — the "I couldn't reach IT" trail |
| `off` | never; every call is still logged and an agent can raise a ticket by hand |

A call that is too short to be a real report is logged without a ticket, and
one click in the call log turns it into a ticket anyway.

**Whose ticket is it?** The extension directory (**Agent Console → Call Log →
Extension directory**) maps an extension to an employee account. When the
caller's extension is mapped, the ticket is filed under that account
(`created_by`), so it appears in that employee's own portal with the "Phone
call" marker; unmapped extensions are shown by their raw number. Only a super
admin can change the directory, and deleting an account leaves its extension
unmapped rather than breaking the log.

**Was it solved?** Two paths, both recorded:

- the linked ticket reaching **Resolved/Closed** marks the call solved and
  stores how long it took from the moment the call came in (phone-call-to-fix
  minutes, alongside the ticket's own MTTR stamps). Reopening the ticket puts
  the call back to **Pending**; cancelling it marks the call **Not solved**.
- an agent can toggle **Solved / Not solved / Pending** on the call itself
  (issues fixed over the phone, with or without a ticket) and leave a note.
  Each call reports its `resolution_source` (`ticket` or `agent`).

**Where to see it.** The Agent Console gains two workspaces:

- **Call Log** — KPIs, filters (day range, direction, outcome, extension,
  ticketed or not, free text), the manual-entry and simulate buttons, the
  extension directory, and a live feed: new or updated calls arrive over the
  socket (`pbx_call_changed`) without a refresh.
- **Call Reports** — the call report with per-extension, per-hour and per-day
  breakdowns plus **Export CSV**.

Visibility follows the ticket rules exactly: a super admin sees every call, an
agent sees their own calls plus the ones nobody has claimed yet. Employees
never reach the call log (`403`).

Before trusting a new wiring, paste a few lines into **Check the SMDR feed**
(`POST /api/pbx/parse`): a dry run that shows exactly what the helpdesk would
read from each line and whether it would raise a ticket, storing nothing.
`GET /api/pbx/status` reports the transport, connection state, counters and any
warnings (unreadable records, a date column that looks off, an assumed
direction). Every `PBX_*` setting is documented with its default in
`backend/.env.example`.

**Safety.** With `PBX_ENABLED` unset the subsystem is off and the rest of the
helpdesk behaves exactly as before. The webhook needs `PBX_TOKEN` (or a
signed-in IT agent), has its own rate limit, and refuses unreadable batches
with the reason instead of logging garbage. A PBX that disappears is retried
with backoff and never takes the API down, and the log is pruned to the newest
`PBX_RETAIN_CALLS` records.

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
persisted reset codes and the rate limiter.

`backend/tests/pbx.test.js` covers the phone-call feature: every Panasonic SMDR
record shape the parser claims to read (plus the header/junk noise a real SMDR
port emits), webhook ingestion with de-duplication and the intercom mirror
merge, extension mapping and attribution, the solved/not-solved lifecycle in
both directions, queue scoping, the report and its CSV, the dry-run parser and
the simulator, the three ticket policies, both TCP feed modes (a stand-in PBX
connecting to us, and us logging in to it) and a PBX that goes away mid-shift.

`.github/workflows/ci.yml` runs all of it plus the frontend lint and build on
every push and pull request.

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
