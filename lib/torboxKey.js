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

// On/off switch that keeps the key saved. While it's off, nothing in the app touches TorBox and
// every title resolves exactly as it did before TorBox existed. Defaults to on.
const ENABLED_KEY = 'reelsync_torbox_enabled';

export function isTorboxEnabled() {
  try {
    return window.localStorage.getItem(ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setTorboxEnabled(on) {
  try {
    window.localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch {}
}

// The key to actually use: '' unless a key is saved AND the switch is on.
export function getActiveTorboxKey() {
  return isTorboxEnabled() ? getTorboxKey() : '';
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

// Preferred audio language for multi-audio releases. '' = just use the file's first track.
export const TORBOX_AUDIO_LANGS = [
  { value: 'eng', label: 'English (default)' },
  { value: 'hin', label: 'Hindi' },
  { value: 'tam', label: 'Tamil' },
  { value: 'tel', label: 'Telugu' },
  { value: 'mal', label: 'Malayalam' },
  { value: 'kan', label: 'Kannada' },
  { value: '', label: 'First track in file' },
];
const AUDIO_KEY = 'reelsync_torbox_audio';

export function getTorboxAudioLang() {
  try {
    const v = window.localStorage.getItem(AUDIO_KEY);
    return v !== null && TORBOX_AUDIO_LANGS.some((l) => l.value === v) ? v : 'eng';
  } catch {
    return 'eng';
  }
}

export function setTorboxAudioLang(value) {
  try {
    window.localStorage.setItem(AUDIO_KEY, String(value));
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
