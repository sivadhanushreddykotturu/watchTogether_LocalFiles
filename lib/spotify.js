'use client';

export function detectSpotifyMarket() {
  if (typeof window === 'undefined') return 'IN';
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz.startsWith('Asia/Kolkata') || tz.startsWith('Asia/Calcutta') || tz.includes('India')) {
      return 'IN';
    }
    if (tz.startsWith('America/')) {
      return 'US';
    }
    if (tz.startsWith('Europe/London')) {
      return 'GB';
    }
    return 'IN';
  } catch (e) {
    return 'IN';
  }
}

export async function searchSpotify(query, signal, marketOverride) {
  const q = String(query || '').trim();
  if (!q) return [];
  const market = marketOverride || detectSpotifyMarket();
  try {
    const res = await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}&market=${encodeURIComponent(market)}`, { signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    if (err.name === 'AbortError') return [];
    console.error('searchSpotify error:', err);
    return [];
  }
}

export async function resolveSpotifyTrack(params) {
  const query = new URLSearchParams();
  if (params.url) query.set('url', params.url);
  if (params.title) query.set('title', params.title);
  if (params.author) query.set('author', params.author);
  if (params.thumbnail) query.set('thumbnail', params.thumbnail);

  try {
    const res = await fetch(`/api/spotify/resolve?${query.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data : null;
  } catch (e) {
    console.error('resolveSpotifyTrack error:', e);
    return null;
  }
}
