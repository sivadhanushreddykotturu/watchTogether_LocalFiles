// Realtime core — all Socket.IO room logic. Framework-agnostic on purpose:
// the Next UI is one client of this; anything else could connect too.

const db = require('./db');
const { AccessToken } = require('livekit-server-sdk');
const { verifyToken } = require('@clerk/backend');

// Verify a Clerk session JWT sent by the client; returns the Clerk user id or
// null. Ownership must be proven with a token — a client-claimed id is never
// trusted for anything that reads or deletes other people's data.
async function verifiedUserId(token) {
  if (!token || !process.env.CLERK_SECRET_KEY) return null;
  try {
    const payload = await verifyToken(String(token), { secretKey: process.env.CLERK_SECRET_KEY });
    return payload && payload.sub ? String(payload.sub) : null;
  } catch {
    return null;
  }
}

// How long to wait before announcing "X left" — mobile lock/unlock blips
// reconnect within this window and never spam the chat.
const LEAVE_GRACE_MS = Number(process.env.LEAVE_GRACE_MS || 45000);

// ---------------------------------------------------------------------------
// Rooms. The in-memory Map is the realtime source of truth; MongoDB is the
// journal — hydrated on first join, written in the background, never awaited.
// room = { code, users: Map<socketId,{name,color}>, recentlyLeft: Map<name,timer>,
//          state: {playing, time, updatedAt} }
// ---------------------------------------------------------------------------
const rooms = new Map();
const sessionToSocket = new Map(); // sessionId -> socketId

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no easily-confused chars
const USER_COLORS = ['#8B5CF6', '#E4572E', '#4ECDC4', '#F2A33C', '#6A8EAE', '#C5D86D', '#EF767A', '#5EB1EF'];

async function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code) || (await db.roomExists(code)));
  return code;
}

// Where the room's playback head is right now, derived from the last control action.
function currentPosition(state) {
  if (!state.playing) return state.time;
  const rate = Number(state.speed) || 1;
  return state.time + ((Date.now() - state.updatedAt) / 1000) * rate;
}

function roomUsers(room) {
  return Array.from(room.users.entries()).map(([id, u]) => ({ id, name: u.name, color: u.color }));
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 24) || 'Anonymous';
}

function freshRoom(code, state) {
  return {
    code,
    users: new Map(),
    recentlyLeft: new Map(),
    voice: new Map(), // socketId -> true while their mic is live
    sessionIds: new Map(), // socketId -> sessionId
    host: null, // socketId of room creator
    controlLock: false, // only host can control video
    adultMode: false, // enables adult content
    state: state || { playing: false, time: 0, updatedAt: Date.now(), subOffset: 0, source: null },
  };
}

function leaveCurrentRoom(io, socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.room = null;
  socket.leave(code);
  if (!room) return;

  const user = room.users.get(socket.id);
  room.users.delete(socket.id);

  // Clean up session identity tracking
  const sid = room.sessionIds?.get(socket.id);
  if (sid) {
    sessionToSocket.delete(sid);
    room.sessionIds?.delete(socket.id);
  }

  if (room.voice.delete(socket.id)) {
    io.to(code).emit('peer-voice', { id: socket.id, on: false });
  }
  io.to(code).emit('user-typing', { id: socket.id, typing: false });
  io.to(code).emit('users', roomUsers(room));

  if (room.users.size === 0) {
    for (const timer of room.recentlyLeft.values()) clearTimeout(timer);
    rooms.delete(code); // evict from memory; Mongo keeps the room for next time
    return;
  }

  // Host migration: the crown passes to the longest-present remaining member,
  // so host-only controls (adult mode, control lock, knocks) never end up
  // owned by a socket that's gone.
  if (room.host === socket.id) {
    room.host = room.users.keys().next().value || null;
    if (room.host) io.to(code).emit('host-change', { newHostId: room.host });
  }

  if (user) {
    const timer = setTimeout(() => {
      room.recentlyLeft.delete(user.name);
    }, LEAVE_GRACE_MS);
    room.recentlyLeft.set(user.name, timer);
  }
}

function joinRoom(io, socket, code, name, { rejoin = false, history } = {}, cb) {
  // Same socket re-entering the SAME room (e.g. the React room page mounts
  // right after create-room): leaving first would evict the empty room out
  // from under us. Refresh membership quietly instead.
  const sameRoomReentry = socket.data.room === code && rooms.has(code);
  if (sameRoomReentry) {
    rooms.get(code).users.delete(socket.id);
  } else {
    leaveCurrentRoom(io, socket);
  }

  const room = rooms.get(code);
  if (!room) {
    if (typeof cb === 'function') cb({ error: 'No room with that code. Check it and try again.' });
    return;
  }

  // Session identity: silently evict any ghost socket still registered for this sessionId.
  const sessionId = socket.data.sessionId || null;
  if (sessionId) {
    const oldSocketId = sessionToSocket.get(sessionId);
    if (oldSocketId && oldSocketId !== socket.id && room.users.has(oldSocketId)) {
      room.users.delete(oldSocketId);
      room.sessionIds?.delete(oldSocketId);
      sessionToSocket.delete(sessionId);
    }
    room.sessionIds.set(socket.id, sessionId);
    sessionToSocket.set(sessionId, socket.id);
  }

  const user = { name: cleanName(name), color: USER_COLORS[room.users.size % USER_COLORS.length] };
  room.users.set(socket.id, user);

  // Host recovery: a room rehydrated from Mongo (or one whose host vanished
  // without a handoff) has no host — the person entering right now takes over
  // so the room is never left leaderless.
  if (!room.host || !room.users.has(room.host)) {
    room.host = socket.id;
    socket.to(code).emit('host-change', { newHostId: room.host });
  }

  socket.data.room = code;
  socket.join(code);

  // A quick rejoin cancels the pending "left" announcement and stays quiet.
  const pendingLeft = room.recentlyLeft.get(user.name);
  if (pendingLeft) {
    clearTimeout(pendingLeft);
    room.recentlyLeft.delete(user.name);
  }

  if (typeof cb === 'function') {
      cb({
        code,
        self: { id: socket.id, ...user },
        users: roomUsers(room),
        voice: Object.fromEntries(room.voice),
        host: room.host,
        adultMode: room.adultMode,
        controlLock: room.controlLock,
        state: {
          playing: room.state.playing,
          time: currentPosition(room.state),
          subOffset: room.state.subOffset || 0,
          source: room.state.source || null,
        },
        history,
      });
  }
  socket.to(code).emit('users', roomUsers(room));
  if (!rejoin && !pendingLeft && !sameRoomReentry) {
    socket.to(code).emit('chat', { system: true, text: `${user.name} joined`, at: Date.now() });
  }
}

// Chat history never blocks a join — the member enters instantly from memory
// and the persisted history streams in right after (deduped client-side).
function streamHistory(socket, code) {
  db.getHistory(code)
    .then((history) => {
      if (history && history.length && socket.connected && socket.data.room === code) {
        socket.emit('chat-history', history);
      }
    })
    .catch(() => {});
}

function attach(io) {
  io.on('connection', (socket) => {
    // --- create a room, returns its join code ---
    socket.on('create-room', async (payload, cb) => {
      let name = '';
      let title = '';
      let ownerId = null;
      let controlLock = false;
      let sessionId = null;
      let authToken = null;

      if (typeof payload === 'string') {
        name = payload;
      } else if (payload && typeof payload === 'object') {
        name = payload.name;
        title = payload.title;
        authToken = payload.authToken || null;
        controlLock = Boolean(payload.controlLock);
        sessionId = payload.sessionId || null;
      }

      if (sessionId) {
        socket.data.sessionId = String(sessionId).slice(0, 64);
      }

      // Ownership is proven, not claimed: a persistent room's owner id comes
      // from a verified Clerk session token. Anything else is a guest room.
      if (authToken) {
        ownerId = await verifiedUserId(authToken);
        if (!ownerId) {
          if (typeof cb === 'function') cb({ error: 'Session expired — please sign in again.' });
          return;
        }
      }

      const code = await makeCode();
      const room = freshRoom(code);
      room.title = String(title || `${cleanName(name)}'s Watch Party`).slice(0, 80);
      room.controlLock = controlLock;
      room.ownerId = ownerId;
      rooms.set(code, room);

      db.saveRoom(code, room.state, { title: room.title, ownerId, ownerName: cleanName(name) });
      joinRoom(io, socket, code, name, { history: [] }, cb);
      room.host = socket.id;
    });

    // --- get user's persistent / recent rooms ---
    socket.on('get-my-rooms', async ({ authToken, sessionId } = {}, cb) => {
      if (typeof cb !== 'function') return;
      // Verified Clerk id when signed in; guests fall back to their local
      // session id (which only ever maps to rooms they created here).
      const id = (await verifiedUserId(authToken)) || (sessionId ? String(sessionId).slice(0, 64) : null);
      if (!id) {
        cb({ rooms: [] });
        return;
      }
      const userRooms = await db.getUserRooms(id);
      const enriched = userRooms.map((r) => {
        const live = rooms.get(r.code);
        return {
          ...r,
          liveCount: live ? live.users.size : 0,
          isLive: Boolean(live),
        };
      });
      cb({ rooms: enriched });
    });

    // --- delete a persistent room ---
    socket.on('delete-room', async ({ code, authToken } = {}, cb) => {
      code = String(code || '').trim().toUpperCase();
      if (!code) {
        if (typeof cb === 'function') cb({ error: 'Code required' });
        return;
      }
      // Only the verified owner may delete — and the live room is only evicted
      // when the delete actually happened (previously anyone who knew a room
      // code could kick everyone by wiping the in-memory room).
      const ownerId = await verifiedUserId(authToken);
      if (!ownerId) {
        if (typeof cb === 'function') cb({ error: 'Sign in to delete this room.' });
        return;
      }
      const success = await db.deleteRoom(code, ownerId);
      if (success) rooms.delete(code);
      if (typeof cb === 'function') cb({ success });
    });

    // --- join an existing room by code (hydrates from Mongo after a restart) ---
    socket.on('join-room', async ({ code, name, rejoin, sessionId } = {}, cb) => {
      code = String(code || '').trim().toUpperCase();
      // Persist sessionId on the socket for dedup and chat stamps
      socket.data.sessionId = String(sessionId || '').slice(0, 64) || null;
      let room = rooms.get(code);

      if (!room) {
        // Rehydration is the only join path that still waits on Mongo: a single
        // existence check (instant when there is no persistence configured).
        const saved = await db.getRoom(code);
        if (!saved) {
          if (typeof cb === 'function') cb({ error: 'No room with that code. Check it and try again.' });
          return;
        }
        room = freshRoom(code, saved.state ? { subOffset: 0, source: null, queue: [], ...saved.state } : undefined);
        rooms.set(code, room);
      }

      // Join instantly from memory; history streams in after.
      joinRoom(io, socket, code, name, { rejoin, history: [] }, cb);
      streamHistory(socket, code);
    });

    // --- playback control: anyone in the room can drive ---
    socket.on('playback', ({ action, time } = {}) => {
      const room = rooms.get(socket.data.room);
      if (!room || !['play', 'pause', 'seek'].includes(action)) return;
      if (room.controlLock && room.host !== socket.id) return; // locked: host only
      time = Math.max(0, Number(time) || 0);

      room.state.time = time;
      room.state.updatedAt = Date.now();
      if (action === 'play') room.state.playing = true;
      if (action === 'pause') room.state.playing = false;

      const user = room.users.get(socket.id);
      socket.to(room.code).emit('playback', {
        action,
        time,
        playing: room.state.playing,
        name: user ? user.name : 'Someone',
      });
      db.saveRoom(room.code, room.state); // background write — broadcast never waits on it
    });

    // --- heartbeat: clients report their position; get the true position back ---
    socket.on('time-update', (time, cb) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      socket.to(room.code).emit('peer-time', { id: socket.id, time: Number(time) || 0 });
      if (typeof cb === 'function') cb({ expected: currentPosition(room.state), playing: room.state.playing });
    });

    // --- chat ---
    socket.on('chat', (payload) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      const user = room.users.get(socket.id);

      let text = '';
      let replyTo = null;
      if (typeof payload === 'string') {
        text = payload;
      } else if (payload && typeof payload === 'object') {
        text = payload.text;
        if (payload.replyTo) {
          replyTo = {
            id: payload.replyTo.id,
            name: String(payload.replyTo.name || '').slice(0, 24),
            color: payload.replyTo.color || '#8A93A6',
            text: String(payload.replyTo.text || '').slice(0, 150),
          };
        }
      }
      text = String(text || '').trim().slice(0, 500);
      if (!text) return;
      const sessionId = socket.data.sessionId || null;
      const msg = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        system: false,
        sender: socket.id,
        senderSessionId: sessionId,
        name: user ? user.name : 'Anonymous',
        color: user ? user.color : '#8A93A6',
        text,
        replyTo,
        at: Date.now(),
      };
      io.to(room.code).emit('chat', msg);
      db.addMessage(room.code, msg); // background write
    });

    // --- subtitle delay: room-wide (it affects sync), persisted with the room ---
    socket.on('subtitle', ({ offset } = {}) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      const o = Math.max(-60000, Math.min(60000, Math.round(Number(offset) || 0)));
      room.state.subOffset = o;
      const user = room.users.get(socket.id);
      socket.to(room.code).emit('subtitle', {
        offset: o,
        name: user ? user.name : 'Someone',
      });
      db.saveRoom(room.code, room.state); // background write
    });

    // --- synced playback speed ---
    socket.on('playback-speed', (speed) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      const rate = Math.min(2, Math.max(0.25, Number(speed) || 1));
      room.state.time = currentPosition(room.state);
      room.state.updatedAt = Date.now();
      room.state.speed = rate;
      const user = room.users.get(socket.id);
      socket.to(room.code).emit('playback-speed', {
        speed: rate,
        name: user ? user.name : 'Someone',
      });
      db.saveRoom(room.code, room.state);
    });

    // --- live typing indicator ---
    socket.on('typing', (isTyping) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      const user = room.users.get(socket.id);
      socket.to(room.code).emit('user-typing', {
        id: socket.id,
        name: user ? user.name : 'Someone',
        color: user ? user.color : '#8A93A6',
        typing: Boolean(isTyping),
      });
    });

    // --- live emoji reactions ---
    socket.on('reaction', (emoji) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      const user = room.users.get(socket.id);
      io.to(room.code).emit('reaction', {
        emoji: String(emoji || '🍿').slice(0, 8),
        sender: socket.id,
        name: user ? user.name : 'Someone',
        color: user ? user.color : '#8A93A6',
        id: Date.now() + Math.random(),
      });
    });

    // --- file metadata for smart match ---
    socket.on('file-meta', ({ duration, size, name } = {}) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      socket.to(room.code).emit('peer-file-meta', {
        id: socket.id,
        duration: Number(duration) || 0,
        size: Number(size) || 0,
        name: String(name || ''),
      });
    });

    // --- source switch: local files <-> YouTube <-> HLS / PH Stream <-> Web Embed <-> Direct Stream. Resetting the source also
    // resets the playhead; everyone (including the setter) applies it uniformly.
    socket.on('source', ({ type, videoId, embedUrl, url, title, platform, viewkey, playing = true } = {}) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      if (room.controlLock && room.host !== socket.id) return; // locked: host only

      if (type === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) {
        room.state.source = { type: 'youtube', videoId, title: String(title || 'YouTube Video').slice(0, 150), platform: 'YouTube' };
        room.state.playing = Boolean(playing);
      } else if ((type === 'hls' || type === 'direct') && url) {
        room.state.source = { type, url: String(url), title: String(title || 'Video Stream').slice(0, 150), platform: String(platform || 'Stream').slice(0, 50), viewkey: viewkey || null };
        room.state.playing = Boolean(playing);
      } else if (type === 'ph' && viewkey) {
        room.state.source = { type: 'ph', viewkey, url: url || null, embedUrl: embedUrl || null, title: String(title || 'PH Video').slice(0, 150), platform: 'PH' };
        room.state.playing = Boolean(playing);
      } else if (type === 'embed' && embedUrl) {
        room.state.source = { type: 'embed', embedUrl: String(embedUrl).slice(0, 500), title: String(title || 'Web Video').slice(0, 150), platform: String(platform || 'Web Embed').slice(0, 50) };
        room.state.playing = Boolean(playing);
      } else {
        room.state.source = null; // back to local files
        room.state.playing = false;
      }
      room.state.time = 0;
      room.state.updatedAt = Date.now();

      const user = room.users.get(socket.id);
      io.to(room.code).emit('source', {
        source: room.state.source,
        playing: room.state.playing,
        time: 0,
        name: user ? user.name : 'Someone',
      });
      db.saveRoom(room.code, room.state); // background write
    });

    // --- queue management ---
    socket.on('queue-add', ({ videoId, type, embedUrl, url, title, platform, viewkey, playNow } = {}, cb) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      if (room.controlLock && room.host !== socket.id) return; // locked: host only
      if (!videoId && !embedUrl && !url && !viewkey) return;

      const itemType = type || (videoId ? 'youtube' : url ? 'hls' : viewkey ? 'ph' : 'embed');
      const user = room.users.get(socket.id);
      const item = {
        id: 'q_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        type: itemType,
        videoId: videoId || null,
        embedUrl: embedUrl || null,
        url: url || null,
        viewkey: viewkey || null,
        title: String(title || (itemType === 'youtube' ? 'YouTube Video' : 'Web Video')).slice(0, 150),
        platform: String(platform || (itemType === 'youtube' ? 'YouTube' : 'Web Video')).slice(0, 50),
        addedBy: socket.id,
        addedByName: user ? user.name : 'Someone',
      };

      if (!room.state.queue) room.state.queue = [];

      if (playNow || (!room.state.source && room.state.queue.length === 0)) {
        room.state.source = {
          type: item.type,
          videoId: item.videoId,
          embedUrl: item.embedUrl,
          url: item.url,
          viewkey: item.viewkey,
          title: item.title,
          platform: item.platform,
        };
        room.state.time = 0;
        room.state.playing = true;
        room.state.updatedAt = Date.now();

        io.to(room.code).emit('source', {
          source: room.state.source,
          playing: true,
          time: 0,
          name: user ? user.name : 'Someone',
        });
        db.saveRoom(room.code, room.state);
      } else {
        room.state.queue.push(item);
        io.to(room.code).emit('queue-update', {
          queue: room.state.queue,
          action: 'add',
          item,
          actor: user ? user.name : 'Someone',
        });
        db.saveRoom(room.code, room.state);
      }
      if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('queue-remove', (itemId) => {
      const room = rooms.get(socket.data.room);
      if (!room || !room.state.queue) return;
      if (room.controlLock && room.host !== socket.id) return; // locked: host only
      room.state.queue = room.state.queue.filter((i) => i.id !== itemId);
      io.to(room.code).emit('queue-update', {
        queue: room.state.queue,
        action: 'remove',
      });
      db.saveRoom(room.code, room.state);
    });

    socket.on('queue-play', (itemId) => {
      const room = rooms.get(socket.data.room);
      if (!room || !room.state.queue) return;
      if (room.controlLock && room.host !== socket.id) return; // locked: host only
      const idx = room.state.queue.findIndex((i) => i.id === itemId);
      if (idx === -1) return;
      const [item] = room.state.queue.splice(idx, 1);
      room.state.source = {
        type: item.type || (item.videoId ? 'youtube' : item.embedUrl ? 'embed' : 'direct'),
        videoId: item.videoId,
        embedUrl: item.embedUrl,
        url: item.url,
        title: item.title,
        platform: item.platform,
      };
      room.state.time = 0;
      room.state.playing = true;
      room.state.updatedAt = Date.now();

      const user = room.users.get(socket.id);
      io.to(room.code).emit('source', {
        source: room.state.source,
        playing: room.state.playing,
        time: 0,
        name: user ? user.name : 'Someone',
      });
      io.to(room.code).emit('queue-update', {
        queue: room.state.queue,
        action: 'play',
        item,
        name: user ? user.name : 'Someone',
      });
      db.saveRoom(room.code, room.state);
    });

    socket.on('queue-next', () => {
      const room = rooms.get(socket.data.room);
      if (!room || !room.state.queue || room.state.queue.length === 0) return;
      if (room.controlLock && room.host !== socket.id) return; // locked: host only
      const item = room.state.queue.shift();
      room.state.source = {
        type: item.type || (item.videoId ? 'youtube' : item.embedUrl ? 'embed' : 'direct'),
        videoId: item.videoId,
        embedUrl: item.embedUrl,
        url: item.url,
        title: item.title,
        platform: item.platform,
      };
      room.state.time = 0;
      room.state.playing = true;
      room.state.updatedAt = Date.now();

      const user = room.users.get(socket.id);
      io.to(room.code).emit('source', {
        source: room.state.source,
        playing: room.state.playing,
        time: 0,
        name: user ? user.name : 'Someone',
      });
      io.to(room.code).emit('queue-update', {
        queue: room.state.queue,
        action: 'next',
        item,
        name: user ? user.name : 'Someone',
      });
      db.saveRoom(room.code, room.state);
    });

    socket.on('queue-clear', () => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      if (room.controlLock && room.host !== socket.id) return; // locked: host only
      room.state.queue = [];
      io.to(room.code).emit('queue-update', {
        queue: [],
        action: 'clear',
      });
      db.saveRoom(room.code, room.state);
    });

    // --- voice: mint a LiveKit join token. Room membership is the only auth;
    // the LiveKit room name is just our room code. ---
    socket.on('voice-token', async (cb) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
      if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
        if (typeof cb === 'function') cb({ error: 'Voice is not configured on this server yet.' });
        return;
      }
      const user = room.users.get(socket.id);
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: socket.id,
        name: user ? user.name : 'Anonymous',
        ttl: '6h', // outlasts any movie
      });
      at.addGrant({ roomJoin: true, room: room.code, canPublish: true, canSubscribe: true });
      if (typeof cb === 'function') cb({ token: await at.toJwt(), url: LIVEKIT_URL });
    });

    // --- mic state relay: lets everyone (even non-voice viewers) see who's live ---
    socket.on('voice-state', ({ on } = {}) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      if (on) room.voice.set(socket.id, true);
      else room.voice.delete(socket.id);
      socket.to(room.code).emit('peer-voice', { id: socket.id, on: !!on });
    });

    // --- Room Lobby: knock to join for locked rooms ---
    // pendingKnocks: Map<knockId, { socket, timer, code, name }>  (module-scoped per connection)
    const pendingKnocks = new Map(); // local to this connection closure

    socket.on('knock-room', ({ code, name, sessionId } = {}) => {
      code = String(code || '').trim().toUpperCase();
      socket.data.sessionId = String(sessionId || '').slice(0, 64) || null;
      const room = rooms.get(code);

      // Room doesn't exist or is not locked → auto-approve entry
      if (!room || !room.controlLock) {
        if (!room) {
          socket.emit('knock-rejected', { code, reason: 'Room not found.' });
          return;
        }
        // Treat as a normal join — instant, with history streaming after.
        joinRoom(io, socket, code, name, { history: [] }, (res) => socket.emit('join-room-ack', res));
        streamHistory(socket, code);
        return;
      }

      // Room is locked — send a knock to the host
      if (!room.host) {
        socket.emit('knock-rejected', { code, reason: 'No host available.' });
        return;
      }

      const knockId = require('crypto').randomUUID();
      const timer = setTimeout(() => {
        if (pendingKnocks.has(knockId)) {
          pendingKnocks.delete(knockId);
          socket.emit('knock-rejected', { knockId, reason: 'Host did not respond in time.' });
        }
      }, 60000);

      pendingKnocks.set(knockId, { socket, timer, code, name });
      io.to(room.host).emit('knock-request', { knockId, name: cleanName(name), socketId: socket.id });
      socket.emit('knock-pending', { knockId });
    });

    // --- Host: approve a pending knock ---
    socket.on('approve-join', ({ knockId, code } = {}) => {
      const room = rooms.get(socket.data.room || code);
      if (!room || room.host !== socket.id) return; // host only
      const knock = pendingKnocks.get(knockId);
      if (!knock) return;
      clearTimeout(knock.timer);
      pendingKnocks.delete(knockId);
      joinRoom(io, knock.socket, knock.code, knock.name, { history: [] }, (res) =>
        knock.socket.emit('join-room-ack', res)
      );
      streamHistory(knock.socket, knock.code);
    });

    // --- Host: reject a pending knock ---
    socket.on('reject-join', ({ knockId } = {}) => {
      const room = rooms.get(socket.data.room);
      if (!room || room.host !== socket.id) return; // host only
      const knock = pendingKnocks.get(knockId);
      if (!knock) return;
      clearTimeout(knock.timer);
      pendingKnocks.delete(knockId);
      knock.socket.emit('knock-rejected', { knockId, reason: 'The host declined your request.' });
    });

    // --- Host controls: lock/unlock video control ---
    socket.on('set-control-lock', (locked) => {
      const room = rooms.get(socket.data.room);
      if (!room || room.host !== socket.id) return; // host only
      room.controlLock = !!locked;
      io.to(room.code).emit('control-lock-change', { controlLock: room.controlLock });
    });

    // --- Host controls: adult mode toggle ---
    socket.on('set-adult-mode', (enabled) => {
      const room = rooms.get(socket.data.room);
      if (!room || room.host !== socket.id) return; // host only
      room.adultMode = !!enabled;
      io.to(room.code).emit('adult-mode-change', { adultMode: room.adultMode });
    });

    // --- NTP clock sync: client sends its local timestamp, server echoes + adds t2 ---
    socket.on('ntp-sync', (clientT1, cb) => {
      if (typeof cb === 'function') cb({ t1: clientT1, t2: Date.now() });
    });

    // --- Transfer host role to another room member ---
    socket.on('transfer-host', (targetSocketId) => {
      const room = rooms.get(socket.data.room);
      if (!room || room.host !== socket.id) return;
      if (room.users.has(targetSocketId)) {
        room.host = targetSocketId;
        io.to(room.code).emit('host-change', { newHostId: targetSocketId });
      }
    });

    socket.on('leave-room', () => leaveCurrentRoom(io, socket));
    socket.on('disconnect', () => leaveCurrentRoom(io, socket));
  });
}

module.exports = { attach, roomCount: () => rooms.size };
