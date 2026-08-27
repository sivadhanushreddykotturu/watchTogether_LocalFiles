// MongoDB persistence layer — the journal, not the engine.
// Everything here is optional: if MONGODB_URI is missing or Atlas is down,
// the app runs fine with zero persistence. Sockets never wait on these calls.

const { MongoClient } = require('mongodb');

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

function addMessage(code, { id, sender, name, color, text, replyTo }) {
  if (!db) return;
  db.collection('messages')
    .insertOne({
      msgId: id || null,
      roomCode: code,
      sender,
      name,
      color,
      text,
      replyTo: replyTo || null,
      at: new Date(),
    })
    .catch((err) => console.error('addMessage failed:', err.message));
}

async function getHistory(code, limit = 50) {
  if (!db) return [];
  try {
    const docs = await db.collection('messages')
      .find({ roomCode: code })
      .sort({ at: -1 })
      .limit(limit)
      .toArray();
    return docs.reverse().map((m) => ({
      id: m.msgId || String(m._id),
      system: false,
      sender: m.sender,
      name: m.name,
      color: m.color,
      text: m.text,
      replyTo: m.replyTo || null,
      at: new Date(m.at).getTime(),
    }));
  } catch { return []; }
}

module.exports = { connect, isConnected, roomExists, getRoom, saveRoom, getUserRooms, deleteRoom, addMessage, getHistory };
