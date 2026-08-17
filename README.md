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

## Deploy: Render

The app is one long-running Node service — pages and WebSockets same-origin — so it deploys to Render as a single unit. (Vercel's serverless model can't hold WebSocket connections, which is why this isn't a Vercel app.)

1. New **Web Service** → this repo (or use **Blueprint** — `render.yaml` is included)
2. Build: `npm install && npm run build` · Start: `npm start`
3. Pick the region closest to your viewers — it's the biggest latency lever
4. Env var: `MONGODB_URI` = your Atlas connection string (Network Access: allow `0.0.0.0/0`)
5. **UptimeRobot**: HTTP monitor on `https://<app>.onrender.com/health`, 5-min interval — keeps the free tier awake 24/7

## Environment variables

| Var | Where | Purpose |
|---|---|---|
| `MONGODB_URI` | Render / `.env` | Atlas connection string (optional — app runs without it, no persistence) |
| `PORT` | Render auto | Server port (default 3000) |
| `LEAVE_GRACE_MS` | optional | Delay before "X left" is announced (default 45000) |
