// Field-level encryption for chat stored in MongoDB (AES-256-GCM).
//
// Encrypted values are strings of the form  enc:v1:<iv>:<tag>:<ciphertext>
// (base64url parts). The room code is bound in as additional authenticated
// data, so a ciphertext copied into another room's document fails to decrypt.
//
// This is encryption at rest: it protects the database (backups, a leaked
// connection string, anyone browsing Atlas). The server holds the key, so it
// is not end-to-end encryption.

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;

let cachedKey;

// CHAT_ENCRYPTION_KEY: 32 random bytes as base64 or 64 hex chars.
// Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
function getKey() {
  if (cachedKey !== undefined) return cachedKey;
  const raw = (process.env.CHAT_ENCRYPTION_KEY || '').trim();
  cachedKey = null;
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    console.error('CHAT_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex chars) — chat will not be persisted.');
    return null;
  }
  cachedKey = buf;
  return cachedKey;
}

function isEnabled() {
  return !!getKey();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plaintext, roomCode) {
  const key = getKey();
  if (!key) throw new Error('CHAT_ENCRYPTION_KEY is not configured');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(roomCode)));
  const ct = Buffer.concat([cipher.update(String(plaintext ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map((b) => b.toString('base64url')).join(':');
}

// Values written before encryption was enabled are plain strings — pass them
// through so old history keeps loading until it expires.
function decrypt(value, roomCode) {
  if (!isEncrypted(value)) return value;
  const key = getKey();
  if (!key) throw new Error('CHAT_ENCRYPTION_KEY is not configured');
  const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAAD(Buffer.from(String(roomCode)));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { isEnabled, isEncrypted, encrypt, decrypt };
