// One-off: encrypt chat messages that were stored before encryption was enabled.
// Safe to re-run — already-encrypted fields are left alone.
//
//   MONGODB_URI=... CHAT_ENCRYPTION_KEY=... node scripts/encrypt-existing-chat.js --dry-run
//   MONGODB_URI=... CHAT_ENCRYPTION_KEY=... node scripts/encrypt-existing-chat.js
const { MongoClient } = require('mongodb');
const chatCrypto = require('../chatCrypto');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  if (!chatCrypto.isEnabled()) throw new Error('CHAT_ENCRYPTION_KEY is missing or invalid');

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const messages = client.db('reelsync').collection('messages');

  const enc = (v, code) => (v == null || chatCrypto.isEncrypted(v) ? v : chatCrypto.encrypt(v, code));
  const needsWork = (m) =>
    [m.text, m.name, m.replyTo?.text, m.replyTo?.name].some((v) => v != null && !chatCrypto.isEncrypted(v));

  let scanned = 0;
  let updated = 0;
  let ops = [];
  const flush = async () => {
    if (ops.length && !DRY_RUN) await messages.bulkWrite(ops, { ordered: false });
    ops = [];
  };

  for await (const m of messages.find({}, { projection: { roomCode: 1, text: 1, name: 1, replyTo: 1 } })) {
    scanned++;
    if (!needsWork(m)) continue;
    const set = { text: enc(m.text, m.roomCode), name: enc(m.name, m.roomCode) };
    if (m.replyTo) {
      set.replyTo = { ...m.replyTo, text: enc(m.replyTo.text, m.roomCode), name: enc(m.replyTo.name, m.roomCode) };
    }
    ops.push({ updateOne: { filter: { _id: m._id }, update: { $set: set } } });
    updated++;
    if (ops.length >= 500) await flush();
  }
  await flush();
  await client.close();

  console.log(`${DRY_RUN ? '[dry run] would encrypt' : 'Encrypted'} ${updated} of ${scanned} messages.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
