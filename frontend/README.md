# SayedFarm Help Desk frontend

This is the React/Vite employee portal and agent console.

Run it from this directory with:

```bash
cp .env.example .env
npm ci
npm run dev
```

Leave `VITE_API_URL` empty for local development. Vite proxies API and Socket.IO requests to `http://localhost:5000`. Set it to the public API URL when the frontend and backend are deployed separately.
