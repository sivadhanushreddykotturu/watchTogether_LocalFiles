// Realtime core — all Socket.IO room logic. Framework-agnostic on purpose:
// the Next UI is one client of this; anything else could connect too.

const db = require('./db');
const { AccessToken } = require('livekit-server-sdk');

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
  if (room.voice.delete(socket.id)) {
    io.to(code).emit('peer-voice', { id: socket.id, on: false });
  }
  io.to(code).emit('users', roomUsers(room));

  if (room.users.size === 0) {
    for (const timer of room.recentlyLeft.values()) clearTimeout(timer);
    rooms.delete(code); // evict from memory; Mongo keeps the room for next time
    return;
  }

  if (user) {
    // Announce the leave only if they don't come back within the grace window.
    const timer = setTimeout(() => {
      room.recentlyLeft.delete(user.name);
      io.to(code).emit('chat', { system: true, text: `${user.name} left`, at: Date.now() });
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
  const user = { name: cleanName(name), color: USER_COLORS[room.users.size % USER_COLORS.length] };
  room.users.set(socket.id, user);
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

function attach(io) {
  io.on('connection', (socket) => {
    // --- create a room, returns its join code ---
    socket.on('create-room', async (name, cb) => {
      const code = await makeCode();
      rooms.set(code, freshRoom(code));
      db.saveRoom(code, rooms.get(code).state);
      joinRoom(io, socket, code, name, { history: [] }, cb);
    });

    // --- join an existing room by code (hydrates from Mongo after a restart) ---
    socket.on('join-room', async ({ code, name, rejoin } = {}, cb) => {
      code = String(code || '').trim().toUpperCase();
      let room = rooms.get(code);

      if (!room) {
        const saved = await db.getRoom(code);
        if (!saved) {
          if (typeof cb === 'function') cb({ error: 'No room with that code. Check it and try again.' });
          return;
        }
        room = freshRoom(code, saved.state ? { subOffset: 0, source: null, queue: [], ...saved.state } : undefined);
        rooms.set(code, room);
      }

      const history = rejoin ? undefined : await db.getHistory(code);
      joinRoom(io, socket, code, name, { rejoin, history }, cb);
    });

    // --- playback control: anyone in the room can drive ---
    socket.on('playback', ({ action, time } = {}) => {
      const room = rooms.get(socket.data.room);
      if (!room || !['play', 'pause', 'seek'].includes(action)) return;
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
    socket.on('chat', (text) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      const user = room.users.get(socket.id);
      text = String(text || '').trim().slice(0, 500);
      if (!text) return;
      const msg = {
        system: false,
        sender: socket.id,
        name: user ? user.name : 'Anonymous',
        color: user ? user.color : '#8A93A6',
        text,
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

    // --- source switch: local files <-> YouTube <-> 18+ Web Embed <-> Direct Stream. Resetting the source also
    // resets the playhead; everyone (including the setter) applies it uniformly.
    socket.on('source', ({ type, videoId, embedUrl, url, title, platform, playing = true } = {}) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;

      if (type === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) {
        room.state.source = { type: 'youtube', videoId, title: String(title || 'YouTube Video').slice(0, 150), platform: 'YouTube' };
        room.state.playing = Boolean(playing);
      } else if (type === 'embed' && embedUrl) {
        room.state.source = { type: 'embed', embedUrl: String(embedUrl).slice(0, 500), title: String(title || 'Web Video').slice(0, 150), platform: String(platform || 'Web Embed').slice(0, 50) };
        room.state.playing = Boolean(playing);
      } else if (type === 'direct' && url) {
        room.state.source = { type: 'direct', url: String(url).slice(0, 500), title: String(title || 'Direct Stream').slice(0, 150), platform: 'Direct Stream' };
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
    socket.on('queue-add', ({ videoId, type, embedUrl, url, title, platform, playNow } = {}, cb) => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      if (!videoId && !embedUrl && !url) return;

      const itemType = type || (videoId ? 'youtube' : embedUrl ? 'embed' : 'direct');
      const user = room.users.get(socket.id);
      const item = {
        id: 'q_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        type: itemType,
        videoId: videoId || null,
        embedUrl: embedUrl || null,
        url: url || null,
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
          title: item.title,
          platform: item.platform,
        };
        room.state.time = 0;
        room.state.playing = true;
        room.state.updatedAt = Date.now();

        io.to(room.code).emit('source', {
          source: room.state.source,
          playing: room.state.playing,
          time: 0,
          name: user ? user.name : 'Someone',
        });
      } else {
        room.state.queue.push(item);
      }

      io.to(room.code).emit('queue-update', {
        queue: room.state.queue,
        action: playNow ? 'play' : 'add',
        item,
        name: user ? user.name : 'Someone',
      });

      db.saveRoom(room.code, room.state);
      if (typeof cb === 'function') cb({ ok: true, queue: room.state.queue });
    });

    socket.on('queue-remove', (itemId) => {
      const room = rooms.get(socket.data.room);
      if (!room || !room.state.queue) return;
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

    socket.on('leave-room', () => leaveCurrentRoom(io, socket));
    socket.on('disconnect', () => leaveCurrentRoom(io, socket));
  });
}

module.exports = { attach, roomCount: () => rooms.size };
