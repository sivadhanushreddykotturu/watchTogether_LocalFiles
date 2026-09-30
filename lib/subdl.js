// lib/subdl.js
// SubDL API integration for fetching high-quality movie & TV subtitles

const SUBDL_API_KEY = process.env.SUBDL_API_KEY || 'subdl_N29f3ozGhXgOz4ZG_3jPIaEhlo-do18dxT38mm3sTxU';
const SUBDL_API_URL = 'https://api.subdl.com/api/v1/subtitles';
const SUBDL_DL_BASE = 'https://dl.subdl.com';

/**
 * Clean subtitle display label from release name or filename
 */
export function cleanSubLabel(releaseName, fileName, lang = 'English') {
  const name = releaseName || fileName || '';
  const isHi = /sdh|hi\b|hearing|cc\b/i.test(name);
  const isBluray = /bluray|bdrip|remux/i.test(name);
  const isWeb = /web-dl|webrip|web\b/i.test(name);
  const isHdtv = /hdtv/i.test(name);

  let tag = '';
  if (isBluray) tag = 'BluRay';
  else if (isWeb) tag = 'WEB';
  else if (isHdtv) tag = 'HDTV';

  if (isHi) tag = tag ? `${tag} · SDH` : 'SDH';

  const shortName = name
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\.[a-z0-9]{3,4}$/i, '')
    .trim();

  if (tag) return `${lang} (${tag})`;
  if (shortName && shortName.length <= 28) return `${lang} · ${shortName}`;
  return lang;
}

/**
 * Searches SubDL for subtitles matching a movie or TV episode.
 * Returns an array of formatted subtitle tracks:
 * [{ id, label, url, directUrl, language, format, size, isHi, releaseName }]
 */
export async function searchSubdl({
  title,
  tmdbId,
  imdbId,
  mediaType = 'movie',
  season,
  episode,
  languages = 'en',
}) {
  try {
    const isTv = mediaType === 'tv' || (season !== undefined && episode !== undefined);
    const sNum = isTv ? (Number(season) || 1) : null;
    const eNum = isTv ? (Number(episode) || 1) : null;

    const params = new URLSearchParams();
    params.set('api_key', SUBDL_API_KEY);
    params.set('unpack', '1');
    if (languages) params.set('languages', languages);
    params.set('type', isTv ? 'tv' : 'movie');

    if (tmdbId) params.set('tmdb_id', String(tmdbId));
    if (imdbId) params.set('imdb_id', String(imdbId));
    if (title) params.set('film_name', title);

    if (isTv) {
      params.set('season_number', String(sNum));
      params.set('episode_number', String(eNum));
    }

    const res = await fetch(`${SUBDL_API_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      if ((tmdbId || imdbId) && title) {
        return searchSubdl({ title, mediaType, season, episode, languages });
      }
      return [];
    }

    const data = await res.json();
    if (!data.status || !Array.isArray(data.subtitles)) {
      return [];
    }

    const tracks = [];
    const seenUrls = new Set();
    const epRegex = isTv
      ? new RegExp(`(?:s0?${sNum}e0?${eNum}|0?${sNum}x0?${eNum}|e0?${eNum}\\b|episode\\s*0?${eNum}\\b)`, 'i')
      : null;

    for (const sub of data.subtitles) {
      const files = Array.isArray(sub.unpack_files) && sub.unpack_files.length > 0
        ? sub.unpack_files
        : (sub.url ? [{
            name: sub.name,
            release_name: sub.release_name,
            url: sub.url,
            format: sub.name?.endsWith('.ass') ? 'ass' : 'srt',
            season: sub.season,
            episode: sub.episode,
            hi: sub.hi,
          }] : []);

      for (const f of files) {
        if (!f.url) continue;

        // If TV show, strictly match the target season & episode
        if (isTv) {
          const fileSeason = (f.season !== undefined && f.season !== null && f.season > 0) ? Number(f.season) : (sub.season ? Number(sub.season) : 0);
          if (fileSeason > 0 && fileSeason !== sNum) continue;

          const fileEp = (f.episode !== undefined && f.episode !== null && f.episode > 0) ? Number(f.episode) : null;
          if (fileEp !== null) {
            if (fileEp !== eNum) continue;
          } else {
            const hasEpMatch = epRegex.test(f.name || '') || epRegex.test(f.release_name || '') ||
                               epRegex.test(sub.name || '') || epRegex.test(sub.release_name || '');
            if (!hasEpMatch) continue;
          }
        }

        const rawDlUrl = f.url.startsWith('http') ? f.url : `${SUBDL_DL_BASE}${f.url}`;
        if (seenUrls.has(rawDlUrl)) continue;
        seenUrls.add(rawDlUrl);

        const langName = sub.lang || sub.language || 'English';
        const label = cleanSubLabel(f.release_name || sub.release_name, f.name || sub.name, langName);

        // Serve through local proxy route to guarantee zero CORS issues and reliable headers
        const proxyUrl = `/api/subtitles/download?url=${encodeURIComponent(rawDlUrl)}`;

        tracks.push({
          id: `subdl-${f.file_n_id || tracks.length + 1}`,
          label,
          url: proxyUrl,
          directUrl: rawDlUrl,
          language: langName,
          format: f.format || 'srt',
          size: f.size || 0,
          isHi: !!(f.hi || sub.hi),
          releaseName: f.release_name || sub.release_name || f.name || sub.name || '',
        });
      }
    }

    // Sort tracks: prefer complete subtitles (> 20KB for movie, > 10KB for TV), prefer non-SDH if available
    tracks.sort((a, b) => {
      const minSize = isTv ? 10000 : 25000;
      const aFull = (a.size || 0) >= minSize ? 1 : 0;
      const bFull = (b.size || 0) >= minSize ? 1 : 0;
      if (aFull !== bFull) return bFull - aFull;
      if (a.isHi !== b.isHi) return a.isHi ? 1 : -1; // Standard dialog before SDH
      return (b.size || 0) - (a.size || 0);
    });

    return tracks;
  } catch (err) {
    console.warn('SubDL search error:', err.message);
    return [];
  }
}
