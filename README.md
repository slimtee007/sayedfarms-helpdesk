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
  self-register as an agent: agent access is granted by an existing agent
  from User Management in the Agent Console.
- Employees only ever see their own tickets (list, updates, chat). The user
  directory and inventory are agent-only; employees get a names-only agent
  picker (`GET /api/agents`) for the "direct request" dropdown.
- Socket.IO chat carries the session token (`socket.auth = { token }`);
  emits from unauthenticated sockets and ticket-room joins for tickets you
  don't own are ignored.

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
