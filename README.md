# SayedFarm IT Help Desk

A small internal IT helpdesk with an employee portal, agent console, ticket ownership, asset inventory, password reset, and ticket-specific chat.

## Architecture

- **Frontend:** React, Vite, Tailwind CSS, Socket.IO client
- **Backend:** Express, JWT, bcrypt, Socket.IO, Nodemailer
- **Persistence:** One JSON data file at `backend/db.json` (created at runtime and ignored by Git)

The SQLite and Mongoose prototypes were removed. The active API is `backend/server.js`.

## Local setup

### Backend

```bash
cd backend
cp .env.example .env
# Set JWT_SECRET and, for agent access on a new data file, BOOTSTRAP_AGENT_* values
npm ci
npm start
```

The server listens on port `5000` by default. `backend/db.json` is created automatically from the empty structure in `backend/db.example.json`.

### Frontend

In a second terminal:

```bash
cd frontend
cp .env.example .env
npm ci
npm run dev
```

When frontend and backend run locally, leave `VITE_API_URL` empty. Vite proxies `/api` and `/socket.io` to the backend. For separate deployments, set `VITE_API_URL` to the public API URL and add that frontend origin to `FRONTEND_ORIGINS` in the backend environment.

## Security notes

- Public signup creates employee accounts only. Agent accounts are provisioned with the `BOOTSTRAP_AGENT_*` environment variables.
- Production requires `JWT_SECRET` and `FRONTEND_ORIGINS`.
- Existing data records without the password-reset migration marker are invalidated at startup and must be reset through the email flow.
- Configure SMTP before enabling password reset in production.
- Do not commit `backend/db.json`, `.env` files, or real user data.

## Tests and checks

```bash
cd backend
npm test

cd ../frontend
npm run build
npm run lint
```
