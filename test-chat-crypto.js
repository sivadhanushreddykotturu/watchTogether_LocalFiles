// Unit test for chat encryption at rest. No server or database needed.
// Run with: npm run test:crypto
const crypto = require('crypto');
const assert = require('assert');

process.env.CHAT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const chatCrypto = require('./chatCrypto');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log('PASS  ' + label);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + label + ' — ' + e.message);
  }
}

const msg = 'rewind to 58:10 pls 🍿 — “quotes” & ünïcødé';

check('encryption is enabled with a valid key', () => assert.strictEqual(chatCrypto.isEnabled(), true));

check('round-trips text, emoji and unicode', () => {
  const enc = chatCrypto.encrypt(msg, 'K7Q2M');
  assert.strictEqual(chatCrypto.decrypt(enc, 'K7Q2M'), msg);
});

check('stored value is prefixed and contains no plaintext', () => {
  const enc = chatCrypto.encrypt(msg, 'K7Q2M');
  assert.ok(enc.startsWith('enc:v1:'));
  assert.ok(!enc.includes('rewind'));
});

check('same text encrypts differently each time (random IV)', () => {
  assert.notStrictEqual(chatCrypto.encrypt(msg, 'K7Q2M'), chatCrypto.encrypt(msg, 'K7Q2M'));
});

check('ciphertext moved to another room fails to decrypt', () => {
  const enc = chatCrypto.encrypt(msg, 'K7Q2M');
  assert.throws(() => chatCrypto.decrypt(enc, 'OTHER'));
});

check('tampered ciphertext fails to decrypt', () => {
  const enc = chatCrypto.encrypt(msg, 'K7Q2M');
  const parts = enc.split(':');
  const ct = Buffer.from(parts[4], 'base64url');
  ct[0] ^= 0xff;
  parts[4] = ct.toString('base64url');
  assert.throws(() => chatCrypto.decrypt(parts.join(':'), 'K7Q2M'));
});

check('legacy plaintext values pass through unchanged', () => {
  assert.strictEqual(chatCrypto.decrypt('old message', 'K7Q2M'), 'old message');
  assert.strictEqual(chatCrypto.isEncrypted('old message'), false);
});

check('empty and missing values round-trip to empty string', () => {
  assert.strictEqual(chatCrypto.decrypt(chatCrypto.encrypt('', 'R'), 'R'), '');
  assert.strictEqual(chatCrypto.decrypt(chatCrypto.encrypt(undefined, 'R'), 'R'), '');
});

console.log(failures === 0 ? '\nAll crypto tests passed.' : `\n${failures} crypto test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
