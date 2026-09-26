// End-to-end encrypted room chat (Web Crypto, runs only in the browser).
//
// Each room has a random 256-bit AES-GCM key that never reaches the server.
// It travels in the invite link's #fragment (browsers never send fragments to
// servers), is kept in localStorage per room, and can be handed from a member
// who has it to a newcomer via an ephemeral ECDH exchange relayed by the
// server. The server only ever sees ciphertext and a one-way key fingerprint.

const PREFIX = 'e2e:v1:';
const STORE_PREFIX = 'reelsync:e2ee:';
const HKDF_SALT = new TextEncoder().encode('reelsync-e2ee-v1');
const enc = new TextEncoder();
const dec = new TextDecoder();

export function isSupported() {
  return typeof window !== 'undefined' && !!(window.crypto && window.crypto.subtle);
}

export function isE2E(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function toB64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- room key ----

export function generateRoomKey() {
  return toB64u(crypto.getRandomValues(new Uint8Array(32)));
}

// One-way fingerprint the server may store to tell clients which key the room uses.
export async function keyIdOf(rawB64) {
  const raw = fromB64u(rawB64);
  const data = new Uint8Array(HKDF_SALT.length + raw.length);
  data.set(HKDF_SALT);
  data.set(raw, HKDF_SALT.length);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return toB64u(new Uint8Array(hash).slice(0, 16));
}

// Short code members can read aloud to confirm they hold the same key.
export function securityCode(keyId) {
  const bytes = fromB64u(keyId);
  const groups = [];
  for (let i = 0; i < 8; i += 2) groups.push(String(((bytes[i] << 8) | bytes[i + 1]) % 10000).padStart(4, '0'));
  return groups.join(' ');
}

export function importRoomKey(rawB64) {
  return crypto.subtle.importKey('raw', fromB64u(rawB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function loadStoredKey(code) {
  try { return localStorage.getItem(STORE_PREFIX + code) || null; } catch { return null; }
}

export function storeKey(code, rawB64) {
  try { localStorage.setItem(STORE_PREFIX + code, rawB64); } catch { /* private mode: key lives for this tab only */ }
}

export function forgetKey(code) {
  try { localStorage.removeItem(STORE_PREFIX + code); } catch { /* ignore */ }
}

// Invite links carry the key as #k=<key>. Returns it (or null) without touching the URL.
export function readKeyFromHash() {
  if (typeof window === 'undefined') return null;
  const m = /(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash || '');
  return m ? m[1] : null;
}

export function inviteLink(origin, code) {
  const key = loadStoredKey(code);
  return `${origin}/room/${code}` + (key ? `#k=${key}` : '');
}

// ---- messages ----

export async function encryptText(key, text, code) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(code) }, key, enc.encode(String(text ?? '')));
  return PREFIX + toB64u(iv) + ':' + toB64u(ct);
}

export async function decryptText(key, value, code) {
  if (!isE2E(value)) return value;
  const [ivB64, ctB64] = value.slice(PREFIX.length).split(':');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(ivB64), additionalData: enc.encode(code) }, key, fromB64u(ctB64));
  return dec.decode(pt);
}

// ---- key hand-off (ephemeral ECDH P-256 → HKDF → AES-GCM wrap) ----

export async function makeEphemeral() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = toB64u(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return { keyPair, pub };
}

async function wrapKeyFrom(privateKey, peerPubB64, code) {
  const peer = await crypto.subtle.importKey('raw', fromB64u(peerPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: enc.encode('room-key-handoff:' + code) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Member side: seal our room key for a newcomer's ephemeral public key.
export async function sealRoomKeyFor(requesterPubB64, rawRoomKeyB64, code) {
  const mine = await makeEphemeral();
  const wrapKey = await wrapKeyFrom(mine.keyPair.privateKey, requesterPubB64, code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(code) }, wrapKey, fromB64u(rawRoomKeyB64));
  return { pub: mine.pub, iv: toB64u(iv), sealed: toB64u(sealed) };
}

// Newcomer side: open a sealed room key with our ephemeral private key.
export async function openRoomKey(ephemeral, { pub, iv, sealed }, code) {
  const wrapKey = await wrapKeyFrom(ephemeral.keyPair.privateKey, pub, code);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(iv), additionalData: enc.encode(code) }, wrapKey, fromB64u(sealed));
  return toB64u(raw);
}
