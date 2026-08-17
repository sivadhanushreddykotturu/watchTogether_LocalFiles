# watchTogether_LocalFiles

**ReelSync** — watch local video files together. Everyone opens their own copy of the file; the server keeps every screen in lockstep (play / pause / seek), with chat alongside. Nothing is ever uploaded.

- Rooms with 5-letter join codes — anyone in the room can drive playback
- Drift correction, reconnect-and-catch-up, presence ticks showing where everyone is
- Mobile is a chat-first companion (unread badge, wake lock, now-playing strip)
- Rooms and chat persist in MongoDB (rooms never expire, chat auto-deletes after 30 days)

## Stack

- **Next.js 16 / React 19** — UI (`app/`)
- **Custom Node server** — Socket.IO realtime (`server.js` + `realtime.js`) in the same process
- **MongoDB Atlas** — the journal, not the engine; sockets never wait on it (`db.js`)

## Local dev

```bash
npm install
npm run dev          # http://localhost:3000
```

Optional persistence: copy `.env.example` to `.env` and set `MONGODB_URI`.

## Tests

```bash
npm run build && npm start   # in one terminal
npm test                     # in another — 26 end-to-end realtime checks
```

## Deploy: Render (recommended — everything in one service)

Vercel serverless can't hold WebSocket connections, so the whole app deploys to Render:

1. New **Web Service** → this repo (or use **Blueprint** — `render.yaml` is included)
2. Build: `npm install && npm run build` · Start: `npm start`
3. Pick the region closest to your viewers
4. Env var: `MONGODB_URI` = your Atlas connection string (Network Access: allow `0.0.0.0/0`)
5. **UptimeRobot**: HTTP monitor on `https://<app>.onrender.com/health`, 5-min interval — keeps the free tier awake 24/7

## Deploy: Vercel frontend + Render realtime (optional split)

If you want the UI on Vercel's CDN, realtime stays on Render:

1. Render service as above, plus env `ALLOWED_ORIGINS=https://<your-app>.vercel.app`
2. Vercel: import this repo (Next.js auto-detected), env `NEXT_PUBLIC_SOCKET_URL=https://<your-app>.onrender.com`

## Environment variables

| Var | Where | Purpose |
|---|---|---|
| `MONGODB_URI` | Render / `.env` | Atlas connection string (optional — app runs without it, no persistence) |
| `PORT` | Render auto | Server port (default 3000) |
| `LEAVE_GRACE_MS` | optional | Delay before "X left" is announced (default 45000) |
| `NEXT_PUBLIC_SOCKET_URL` | Vercel only | Point UI at the Render realtime service |
| `ALLOWED_ORIGINS` | Render only | Comma-separated origins allowed to open sockets |
