# watchTogether_LocalFiles

**ReelSync** — watch local video files together. Everyone opens their own copy of the file; the server keeps every screen in lockstep (play / pause / seek), with chat alongside. Nothing is ever uploaded.

- Rooms with 5-letter join codes — anyone in the room can drive playback
- Drift correction, reconnect-and-catch-up, presence ticks showing where everyone is
- Mobile is a chat-first companion (unread badge, wake lock, now-playing strip)
- Rooms and chat persist in MongoDB (rooms never expire, chat auto-deletes after 30 days)
- **Chat is end-to-end encrypted.** Each room has a key generated in the browser (AES-256-GCM, Web Crypto) — the server and MongoDB only ever see ciphertext plus a one-way key fingerprint, never the key itself or readable text. See [End-to-end chat encryption](#end-to-end-chat-encryption) below.

## End-to-end chat encryption

Chat text, quoted replies and GIF links are encrypted in the browser before they leave it (`lib/e2ee.js`). The server relays ciphertext and a key fingerprint; it never sees the key or plaintext, and refuses any message that isn't ciphertext once a room has a key.

How the key reaches people:
- **Invite link** — the key rides after `#` in the URL, which browsers never send to a server. It's saved for that room on arrival and then scrubbed from the address bar.
- **Joining by typed code** — the room asks whoever's already there; any member holding the key seals it to the newcomer's ephemeral key (ECDH P-256 → HKDF → AES-GCM) and the server just relays the sealed blob.
- **Returning later on the same browser** — the key is remembered locally, so it works even alone in the room.
- **Nobody with the key online** — chat shows as locked and unlocks itself the moment someone who has it joins. Only the room's creator can start a new key if it's genuinely lost (older messages then stay unreadable).

The room menu shows a short security code — everyone in the room should see the same one; if not, something intercepted the key hand-off.

This protects message content specifically. Names, timestamps and room membership are still visible to the server, and — like any web app — you're trusting the served JS to be honest.

Chat is *also* encrypted at rest server-side (`CHAT_ENCRYPTION_KEY`), independent of the above: it additionally covers display names, and is what protects anything saved before end-to-end encryption existed or from a database-level leak.

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
npm test                     # in another — 47 end-to-end realtime checks
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
| `CHAT_ENCRYPTION_KEY` | Render / `.env` | 32-byte key that encrypts chat *at rest* before it's stored (separate from the per-room end-to-end key, which the server never sees). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Without it, chat still works live but isn't saved. Keep it secret and don't change it — messages saved under an old key can't be read with a new one. |
| `PORT` | Render auto | Server port (default 3000) |
| `LEAVE_GRACE_MS` | optional | Delay before "X left" is announced (default 45000) |
| `LIVEKIT_URL` | Render / `.env` | LiveKit Cloud project URL — enables voice chat (optional; app runs fine without it) |
| `LIVEKIT_API_KEY` | Render / `.env` | LiveKit Cloud API key |
| `LIVEKIT_API_SECRET` | Render / `.env` | LiveKit Cloud API secret |
