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

export const SUBDL_LANG_MAP = {
  english: 'en', en: 'en',
  spanish: 'es', es: 'es', espanol: 'es',
  french: 'fr', fr: 'fr', francais: 'fr',
  german: 'de', de: 'de', deutsch: 'de',
  italian: 'it', it: 'it', italiano: 'it',
  portuguese: 'pt', pt: 'pt',
  russian: 'ru', ru: 'ru',
  hindi: 'hi', hi: 'hi',
  telugu: 'te', te: 'te',
  tamil: 'ta', ta: 'ta',
  japanese: 'ja', ja: 'ja',
  korean: 'ko', ko: 'ko',
  chinese: 'zh', zh: 'zh',
  arabic: 'ar', ar: 'ar',
  turkish: 'tr', tr: 'tr',
  indonesian: 'id', id: 'id',
  vietnamese: 'vi', vi: 'vi',
  thai: 'th', th: 'th',
  polish: 'pl', pl: 'pl',
  dutch: 'nl', nl: 'nl',
  greek: 'el', el: 'el',
  farsi: 'fa', persian: 'fa', fa: 'fa',
  romanian: 'ro', ro: 'ro',
  all: '',
};

export function normalizeSubdlLang(lang) {
  if (!lang) return 'en';
  const clean = String(lang).trim().toLowerCase();
  if (clean === 'all') return '';
  return SUBDL_LANG_MAP[clean] || clean;
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
    // Strictly verify TV vs Movie to prevent movies from getting searched as TV shows
    const sVal = season !== undefined && season !== null && String(season).trim() !== '' ? Number(season) : null;
    const eVal = episode !== undefined && episode !== null && String(episode).trim() !== '' ? Number(episode) : null;
    const isTv = mediaType === 'tv' || (sVal !== null && eVal !== null && sVal > 0);

    const sNum = isTv ? (sVal || 1) : null;
    const eNum = isTv ? (eVal || 1) : null;

    const normLang = normalizeSubdlLang(languages);

    const buildParams = (useTmdb = true, useTitle = true) => {
      const p = new URLSearchParams();
      p.set('api_key', SUBDL_API_KEY);
      p.set('unpack', '1');
      if (normLang) p.set('languages', normLang);
      p.set('type', isTv ? 'tv' : 'movie');

      if (useTmdb && tmdbId) p.set('tmdb_id', String(tmdbId));
      if (useTmdb && imdbId) p.set('imdb_id', String(imdbId));
      if (useTitle && title) p.set('film_name', title);

      if (isTv) {
        p.set('season_number', String(sNum));
        p.set('episode_number', String(eNum));
      }
      return p;
    };

    let res = await fetch(`${SUBDL_API_URL}?${buildParams(true, true).toString()}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json' },
    });

    let data = res.ok ? await res.json() : null;

    // If search with TMDB ID returned 0 results, retry with clean film title
    if ((!data || !data.status || !Array.isArray(data.subtitles) || data.subtitles.length === 0) && title && tmdbId) {
      try {
        const fallbackRes = await fetch(`${SUBDL_API_URL}?${buildParams(false, true).toString()}`, {
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/json' },
        });
        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          if (fallbackData.status && Array.isArray(fallbackData.subtitles) && fallbackData.subtitles.length > 0) {
            data = fallbackData;
          }
        }
      } catch {}
    }

    if (!data || !data.status || !Array.isArray(data.subtitles)) {
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
