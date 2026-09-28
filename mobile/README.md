# SayedFarms Helpdesk — Mobile (employee portal)

A mobile-first web app for **employees**: raise IT requests, follow their live
status, chat with the assigned agent, and get help over live IT chat — all
from a phone. It talks to the **same backend** as the desktop frontend
(`../backend`), so accounts, tickets, chat history and role rules are shared.

> Scope: this app is the **employee portal**. The Agent Console (dispatch,
> user management, assets, PBX call log, reports) stays desktop-only for now —
> but an agent who signs in here still sees their assigned queue and can read
> and reply in ticket chats.

## Running it

**1. Backend** (port 5000) — see the root README:

```bash
cd backend
npm install
npm start
```

**2. Mobile app** (port 5174, proxies `/api` and `/socket.io` to the backend):

```bash
cd mobile
npm install
npm run dev
```

Open http://localhost:5174 — best viewed in a phone-sized viewport (browser
devtools device mode, or just make the window narrow). Add it to your home
screen from a phone browser to run it like an installed app (web app
manifest included).

## Screens

| Screen | Route | What it does |
|---|---|---|
| Sign in / Sign up | `/login`, `/signup` | Same accounts as desktop; public signups are always employee accounts |
| Forgot password | `/forgot-password` | OTP reset flow; shows the dev code when SMTP is not configured |
| Home | `/home` | Greeting, live ticket counters, quick-request shortcuts, recent activity |
| My Requests | `/requests` | Searchable, filterable queue of the signed-in user's tickets; pull to refresh |
| Request detail | `/requests/:id` | Full-screen view: details, attachment lightbox, live message thread, cancel action |
| New request | `/new` | Full-screen sheet: summary, details, category chips, urgency, direct-to-agent picker, photo attachment |
| Live IT chat | `/chat` | Real-time broadcast chat with whoever is around (not persisted — raise a ticket to track work) |
| Profile | `/profile` | Account summary, request stats, sign out |

## Native-app feel

- Bottom tab bar with a raised centre "new request" action, safe-area aware
  (notch + home-indicator insets via `env(safe-area-inset-*)`)
- Full-screen push navigation for ticket detail; slide-up sheet for new request
- Pull-to-refresh on the list screens (touch gesture with rubber-banding)
- Bottom action sheets instead of `confirm()` dialogs; toasts for feedback
- Skeleton loaders, press feedback (`scale(0.97)` on active), no text zoom-out
- Web app manifest + icons: installable to the home screen, standalone display

## Architecture notes

- **Stack**: React 19 + Vite + Tailwind CSS 4 + react-router 7 +
  socket.io-client — deliberately the same stack as `../frontend` so pieces
  can be shared or merged later.
- **`src/lib/api.js`** — tiny fetch wrapper returning `{ ok, status, data }`,
  session storage helpers (same `token` / `user` localStorage keys as the
  desktop app), and the shared socket singleton.
- **`src/context/SessionContext.jsx`** — session lifecycle: login/signup/
  logout, socket authentication, and picking up role changes via
  `GET /api/auth/me` (same contract as the desktop console).
- **`src/context/TicketsContext.jsx`** — loads tickets + agent directory +
  server enums in one place. The server scopes the ticket list per role
  (employees: their own tickets; agents: assigned tickets), so the mobile app
  never needs filtering logic of its own. Socket events
  (`ticket_changed` / `ticket_created`) debounce into a silent refresh.
- **API contract** — unchanged from the backend's perspective:
  - `POST /api/tickets` with `{ title, description, category, priority,
    assigned_to_id, image }` (the `Unassigned` sentinel means "any agent")
  - `POST /api/tickets/:id/messages` with `{ text }` for the per-ticket thread
    (sent over REST so it persists even mid-reconnect; received live over the
    ticket's socket room)
  - Employees can `PATCH /api/tickets/:id` only with `{ status: 'Cancelled' }`
    — the app hides the cancel action everywhere else and the server still
    enforces it
- Attachments are data-URLs with a 1.5 MB client-side guard (matching the
  server's ~2 MB base64 ceiling) so oversized screenshots fail *before*
  submit, with the draft preserved.

## Not implemented (yet)

- Push notifications (needs a service worker + a push server)
- Agent-focused screens (dispatch queue, assets, PBX, reports)
- Offline queueing of drafts
