'use client';

export async function searchSpotify(query, signal) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const res = await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}`, { signal });
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
