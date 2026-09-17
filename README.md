# sayedfarms-helpdesk
SayedFarms IT helpdesk OS

## Running locally

**Backend** (port 5000):

```bash
cd backend
npm install
cp .env.example .env   # then edit .env with real SMTP settings
npm start
```

**Frontend** (port 5173, proxies `/api` and `/socket.io` to the backend):

```bash
cd frontend
npm install
npm run dev
```

## Password reset emails (SMTP)

The "Forgot Password" flow emails a 6-digit code to the user. Emails are
**only delivered when SMTP is configured** in `backend/.env`
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, optional `MAIL_FROM`).
See `backend/.env.example` for Office 365 / Gmail settings.

If SMTP is not configured, the app says so on screen and (outside
`NODE_ENV=production`) shows the reset code directly in the page instead of
silently pretending an email was sent.
