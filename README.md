# watchTogether_LocalFiles

**ReelSync** — watch local video files together. Everyone opens their own copy of the file; the server keeps every screen in lockstep (play / pause / seek), with chat alongside. Nothing is ever uploaded.

- Rooms with 5-letter join codes — anyone in the room can drive playback
- Drift correction, reconnect-and-catch-up, presence ticks showing where everyone is
- Mobile is a chat-first companion (unread badge, wake lock, now-playing strip)
- Rooms and chat persist in MongoDB (rooms never expire, chat auto-deletes after 30 days)
- **End-to-end encrypted chat**: each room has a key generated in the browser (AES-256-GCM, Web Crypto). The server and MongoDB only ever see ciphertext plus a one-way key fingerprint. The key reaches people via the invite link's `#fragment` (never sent to servers), is remembered per room in the browser, and is handed from any member who has it to someone who joined by typed code (ephemeral ECDH P-256). Members can compare a security code in the room menu. See `lib/e2ee.js`.
- Chat is also encrypted at rest on the server (`CHAT_ENCRYPTION_KEY`), which additionally covers display names and anything stored before E2EE

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

```bash
npm run test:crypto          # chat encryption unit tests, no server needed
```

Encrypting chat saved before `CHAT_ENCRYPTION_KEY` was set (one-off, safe to re-run):

```bash
MONGODB_URI=... CHAT_ENCRYPTION_KEY=... npm run encrypt-existing-chat -- --dry-run
MONGODB_URI=... CHAT_ENCRYPTION_KEY=... npm run encrypt-existing-chat
```

## Deploy: Render

The app is one long-running Node service — pages and WebSockets same-origin — so it deploys to Render as a single unit. (Vercel's serverless model can't hold WebSocket connections, which is why this isn't a Vercel app.)

1. New **Web Service** → this repo (or use **Blueprint** — `render.yaml` is included)
2. Build: `npm install && npm run build` · Start: `npm start`
3. Pick the region closest to your viewers — it's the biggest latency lever
4. Env vars: `MONGODB_URI` = your Atlas connection string (Network Access: allow `0.0.0.0/0`), and `CHAT_ENCRYPTION_KEY` (see below)
5. **UptimeRobot**: HTTP monitor on `https://<app>.onrender.com/health`, 5-min interval — keeps the free tier awake 24/7

## Environment variables

| Var | Where | Purpose |
|---|---|---|
| `MONGODB_URI` | Render / `.env` | Atlas connection string (optional — app runs without it, no persistence) |
| `CHAT_ENCRYPTION_KEY` | Render / `.env` | 32-byte key that encrypts chat before it's stored. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Without it, chat still works live but isn't saved. Keep it secret and don't change it — messages saved under an old key can't be read with a new one. |
| `PORT` | Render auto | Server port (default 3000) |
| `LEAVE_GRACE_MS` | optional | Delay before "X left" is announced (default 45000) |
| `LIVEKIT_URL` | Render / `.env` | LiveKit Cloud project URL — enables voice chat (optional; app runs fine without it) |
| `LIVEKIT_API_KEY` | Render / `.env` | LiveKit Cloud API key |
| `LIVEKIT_API_SECRET` | Render / `.env` | LiveKit Cloud API secret |
