// Client-side TorBox API key storage. The key lives only in this browser's
// localStorage; it is sent per request (x-torbox-key header) to our own
// /api/torbox/* routes, which never store it.

const STORAGE_KEY = 'reelsync_torbox_key';

export function getTorboxKey() {
  try {
    if (typeof window === 'undefined') return '';
    return (window.localStorage.getItem(STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function setTorboxKey(key) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(key || '').trim());
  } catch {}
}

export function clearTorboxKey() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// Stream quality for TorBox playback. Values are TorBox resolution indexes as strings:
// '4' = 720p, '5' = 1080p (default), '7' = 2160p, 'null' = original resolution.
export const TORBOX_QUALITIES = [
  { value: '4', label: '720p' },
  { value: '5', label: '1080p (default)' },
  { value: '7', label: '4K' },
  { value: 'null', label: 'Original' },
];
const QUALITY_KEY = 'reelsync_torbox_quality';

export function getTorboxQuality() {
  try {
    const v = window.localStorage.getItem(QUALITY_KEY);
    return TORBOX_QUALITIES.some((q) => q.value === v) ? v : '5';
  } catch {
    return '5';
  }
}

export function setTorboxQuality(value) {
  try {
    window.localStorage.setItem(QUALITY_KEY, String(value));
  } catch {}
}

// Ask the server to check a key against TorBox. Resolves to
// { ok, plan, isPro, expiresAt } or { ok: false, error }.
export async function verifyTorboxKey(key) {
  try {
    const res = await fetch('/api/torbox/verify', {
      headers: { 'x-torbox-key': String(key || '').trim() },
      signal: AbortSignal.timeout(10000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: 'Could not reach TorBox' };
  }
}
