// MongoDB persistence layer — the journal, not the engine.
// Everything here is optional: if MONGODB_URI is missing or Atlas is down,
// the app runs fine with zero persistence. Sockets never wait on these calls.

const { MongoClient } = require('mongodb');
const chatCrypto = require('./chatCrypto');

const DB_NAME = 'reelsync';
const CHAT_TTL_SECONDS = 30 * 24 * 60 * 60; // chat auto-deletes after 30 days

let db = null;

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('MONGODB_URI not set — running without persistence.');
    return;
  }
  try {
    const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db(DB_NAME);
    await db.collection('rooms').createIndex({ code: 1 }, { unique: true });
    await db.collection('messages').createIndex({ roomCode: 1, at: 1 });
    await db.collection('messages').createIndex({ at: 1 }, { expireAfterSeconds: CHAT_TTL_SECONDS });
    console.log('MongoDB connected.');
    if (!chatCrypto.isEnabled()) {
      console.warn('CHAT_ENCRYPTION_KEY not set — chat history will NOT be saved (messages stay live-only).');
    }
  } catch (err) {
    console.error('MongoDB connection failed — running without persistence:', err.message);
    db = null;
  }
}

function isConnected() {
  return !!db;
}

// ---- rooms ----

async function roomExists(code) {
  if (!db) return false;
  try {
    return !!(await db.collection('rooms').findOne({ code }, { projection: { _id: 1 } }));
  } catch { return false; }
}

async function getRoom(code) {
  if (!db) return null;
  try {
    return await db.collection('rooms').findOne({ code });
  } catch { return null; }
}

// Fire-and-forget: never awaited by socket handlers.
function saveRoom(code, state, meta = {}) {
  if (!db) return;
  const updateData = { code, state, lastActiveAt: new Date() };
  if (meta.title) updateData.title = meta.title;
  if (meta.ownerId) updateData.ownerId = meta.ownerId;
  if (meta.ownerName) updateData.ownerName = meta.ownerName;
  if (meta.controlLock !== undefined) updateData.controlLock = Boolean(meta.controlLock);
  if (meta.e2eeKeyId !== undefined) updateData.e2eeKeyId = meta.e2eeKeyId;
  if (meta.creatorSessionId) updateData.creatorSessionId = meta.creatorSessionId;

  db.collection('rooms').updateOne(
    { code },
    { $set: updateData, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  ).catch((err) => console.error('saveRoom failed:', err.message));
}

async function getUserRooms(ownerId) {
  if (!db || !ownerId) return [];
  try {
    const docs = await db.collection('rooms')
      .find({ ownerId })
      .sort({ lastActiveAt: -1 })
      .limit(10)
      .toArray();
    return docs.map((d) => ({
      code: d.code,
      title: d.title || `Room ${d.code}`,
      ownerName: d.ownerName || 'Host',
      source: d.state?.source || null,
      lastActiveAt: d.lastActiveAt || d.createdAt,
    }));
  } catch {
    return [];
  }
}

async function deleteRoom(code, ownerId) {
  if (!db || !code) return false;
  try {
    const query = { code };
    if (ownerId) query.ownerId = ownerId;
    await db.collection('rooms').deleteOne(query);
    await db.collection('messages').deleteMany({ roomCode: code });
    return true;
  } catch {
    return false;
  }
}

// ---- chat ----

// Message content (text, display names, quoted replies) is encrypted before
// it reaches Mongo; without a key we don't persist chat at all rather than
// fall back to plaintext.
function addMessage(code, { id, sender, name, color, text, replyTo }) {
  if (!db || !chatCrypto.isEnabled()) return;
  let doc;
  try {
    doc = {
      msgId: id || null,
      roomCode: code,
      sender,
      name: chatCrypto.encrypt(name, code),
      color,
      text: chatCrypto.encrypt(text, code),
      replyTo: replyTo
        ? {
            id: replyTo.id,
            color: replyTo.color,
            name: chatCrypto.encrypt(replyTo.name, code),
            text: chatCrypto.encrypt(replyTo.text, code),
          }
        : null,
      at: new Date(),
    };
  } catch (err) {
    console.error('addMessage encrypt failed:', err.message);
    return;
  }
  db.collection('messages')
    .insertOne(doc)
    .catch((err) => console.error('addMessage failed:', err.message));
}

function readMessage(code, m) {
  const reply = m.replyTo
    ? {
        ...m.replyTo,
        name: chatCrypto.decrypt(m.replyTo.name, code),
        text: chatCrypto.decrypt(m.replyTo.text, code),
      }
    : null;
  return {
    id: m.msgId || String(m._id),
    system: false,
    sender: m.sender,
    name: chatCrypto.decrypt(m.name, code),
    color: m.color,
    text: chatCrypto.decrypt(m.text, code),
    replyTo: reply,
    at: new Date(m.at).getTime(),
  };
}

async function getHistory(code, limit = 50) {
  if (!db) return [];
  try {
    const docs = await db.collection('messages')
      .find({ roomCode: code })
      .sort({ at: -1 })
      .limit(limit)
      .toArray();
    const out = [];
    let unreadable = 0;
    for (const m of docs.reverse()) {
      try {
        out.push(readMessage(code, m));
      } catch {
        unreadable++; // wrong/rotated key or tampered row — drop it, keep the rest
      }
    }
    if (unreadable) console.warn(`getHistory(${code}): skipped ${unreadable} message(s) that failed to decrypt`);
    return out;
  } catch { return []; }
}

module.exports = { connect, isConnected, roomExists, getRoom, saveRoom, getUserRooms, deleteRoom, addMessage, getHistory };
