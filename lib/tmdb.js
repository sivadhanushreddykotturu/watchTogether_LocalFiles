// TMDB and Vidlove Player Helper Utilities for ReelSync

export function buildVidloveUrl({ tmdbId, type = 'movie', season = 1, episode = 1, options = {} }) {
  if (!tmdbId) return '';

  const isTv = type === 'tv';
  const base = isTv
    ? `https://player.vidlove.cc/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`
    : `https://player.vidlove.cc/embed/movie/${tmdbId}`;

  const params = new URLSearchParams({
    primarycolor: options.primarycolor || 'ff4d6d',
    secondarycolor: options.secondarycolor || 'c49de8',
    iconcolor: options.iconcolor || 'ffffff',
    autoplay: options.autoplay !== undefined ? String(options.autoplay) : 'true',
    poster: options.poster !== undefined ? String(options.poster) : 'true',
    chromecast: options.chromecast !== undefined ? String(options.chromecast) : 'true',
    servericon: options.servericon !== undefined ? String(options.servericon) : 'true',
    setting: options.setting !== undefined ? String(options.setting) : 'true',
    pip: options.pip !== undefined ? String(options.pip) : 'true',
    server: options.server || 'auto',
  });

  if (options.font) params.set('font', options.font);
  if (options.fontcolor) params.set('fontcolor', options.fontcolor);
  if (options.fontsize) params.set('fontsize', String(options.fontsize));
  if (options.opacity) params.set('opacity', String(options.opacity));
  if (options.logourl) params.set('logourl', options.logourl);

  return `${base}?${params.toString()}`;
}

export async function fetchTmdbTrending({ type = 'all', signal } = {}) {
  try {
    const res = await fetch(`/api/tmdb?action=trending&type=${encodeURIComponent(type)}`, { signal });
    if (!res.ok) throw new Error(`Trending request failed: ${res.status}`);
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('fetchTmdbTrending error:', err);
    return [];
  }
}

export async function searchTmdb(query, { type = 'all', signal } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const res = await fetch(`/api/tmdb?action=search&q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`, { signal });
    if (!res.ok) throw new Error(`Search request failed: ${res.status}`);
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('searchTmdb error:', err);
    return [];
  }
}

export async function fetchTmdbTvDetails(id, { signal } = {}) {
  if (!id) return null;
  try {
    const res = await fetch(`/api/tmdb?action=tv&id=${encodeURIComponent(id)}`, { signal });
    if (!res.ok) throw new Error(`TV details request failed: ${res.status}`);
    const data = await res.json();
    return data.tv || null;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('fetchTmdbTvDetails error:', err);
    return null;
  }
}

export async function fetchTmdbSeason(id, season = 1, { signal } = {}) {
  if (!id) return null;
  try {
    const res = await fetch(`/api/tmdb?action=season&id=${encodeURIComponent(id)}&season=${encodeURIComponent(season)}`, { signal });
    if (!res.ok) throw new Error(`Season request failed: ${res.status}`);
    const data = await res.json();
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('fetchTmdbSeason error:', err);
    return null;
  }
}

export async function fetchTmdbMovieDetails(id, { signal } = {}) {
  if (!id) return null;
  try {
    const res = await fetch(`/api/tmdb?action=movie&id=${encodeURIComponent(id)}`, { signal });
    if (!res.ok) throw new Error(`Movie details request failed: ${res.status}`);
    const data = await res.json();
    return data.movie || null;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('fetchTmdbMovieDetails error:', err);
    return null;
  }
}

export async function fetchTmdbSources({ id, type = 'movie', season = 1, episode = 1, signal } = {}) {
  if (!id) return { subtitles: [], hasServers: false };
  try {
    const res = await fetch(
      `/api/tmdb?action=sources&id=${encodeURIComponent(id)}&type=${encodeURIComponent(type)}&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`,
      { signal }
    );
    if (!res.ok) throw new Error(`Sources request failed: ${res.status}`);
    const data = await res.json();
    return data || { subtitles: [], hasServers: false };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('fetchTmdbSources error:', err);
    return { subtitles: [], hasServers: false };
  }
}

