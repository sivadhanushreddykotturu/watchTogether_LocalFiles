const https = require('https');
const fs = require('fs');
const path = require('path');

const agent = new https.Agent({ keepAlive: true, timeout: 10000 });

// Embedded KissKH token generator function extracted directly from kisskh.is common.js
let commonCode = '';
try {
  commonCode = fs.readFileSync(path.join(process.cwd(), 'lib', 'kisskh_common.js'), 'utf8');
} catch {
  try {
    commonCode = fs.readFileSync(path.join(__dirname, 'kisskh_common.js'), 'utf8');
  } catch (e) {
    console.error('Failed to load kisskh_common.js:', e.message);
  }
}
const cleanCode = commonCode.replace(/function setMediaSession[\s\S]*?;\s*var _0x54b9=/, 'var _0x54b9=');

const keyGenFn = new Function(`
${cleanCode}
return function generateKey(epId, guid) {
  return _0x54b991(epId, null, '2.8.10', guid, 4830201, 'kisskh', 'kisskh', 'kisskh', 'kisskh', 'kisskh', 'kisskh');
};
`)();

const VIDEO_GUID = '62f176f3bb1b5b8e70e39932ad34a0c7';
const SUB_GUID = 'VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp';

function fetchJson(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Referer': 'https://kisskh.is/',
        'Origin': 'https://kisskh.is',
        'Accept': 'application/json, text/plain, */*',
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      if (retries > 0) {
        setTimeout(() => {
          fetchJson(url, retries - 1).then(resolve).catch(reject);
        }, 300);
      } else {
        reject(err);
      }
    });

    req.setTimeout(8000, () => {
      req.destroy();
      if (retries > 0) {
        fetchJson(url, retries - 1).then(resolve).catch(reject);
      } else {
        reject(new Error('Request timeout'));
      }
    });
  });
}

function calculateTitleScore(targetTitle, candidateTitle) {
  const clean = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const t = clean(targetTitle);
  const c = clean(candidateTitle);

  if (!t || !c) return 0;
  if (t === c) return 1.0;

  const stopWords = new Set(['a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 's', 'part']);
  const tWords = t.split(' ').filter(w => w.length > 1 && !stopWords.has(w));
  const cWords = c.split(' ').filter(w => w.length > 1 && !stopWords.has(w));

  if (tWords.length === 0 || cWords.length === 0) return 0;
  const cSet = new Set(cWords);

  let matched = 0;
  for (const w of tWords) {
    if (cSet.has(w)) matched++;
  }

  const targetRecall = matched / tWords.length;
  // If more than 30% of target keywords are missing, reject completely
  if (targetRecall < 0.70) return 0;

  // Short titles (e.g. "Marvel's Avengers") must match all distinctive keywords
  if (tWords.length <= 2 && matched < tWords.length) {
    return 0;
  }

  const candidatePrecision = matched / Math.max(cWords.length, tWords.length);
  return (2 * targetRecall * candidatePrecision) / (targetRecall + candidatePrecision);
}

async function extractKisskhHttp(tmdbId, type = 'movie', season = 1, episode = 1) {
  const tmdbUrl = `https://api.themoviedb.org/3/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=baf435afe9fef24b14b2a137359e4124`;
  const tmdbData = await fetchJson(tmdbUrl);
  if (!tmdbData) throw new Error('KissKH: TMDB metadata fetch failed');

  const title = tmdbData.title || tmdbData.name || '';
  const origTitle = tmdbData.original_title || tmdbData.original_name || '';
  const year = (tmdbData.release_date || tmdbData.first_air_date || '').slice(0, 4);

  if (!title) throw new Error('KissKH: TMDB title empty');

  const cleanTitle = title.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();
  let searchRes = await fetchJson(`https://kisskh.is/api/DramaList/Search?q=${encodeURIComponent(cleanTitle)}`);
  if ((!searchRes || searchRes.length === 0) && origTitle && origTitle !== title) {
    searchRes = await fetchJson(`https://kisskh.is/api/DramaList/Search?q=${encodeURIComponent(origTitle)}`);
  }

  if (!searchRes || searchRes.length === 0) throw new Error(`KissKH: No search results for "${cleanTitle}"`);

  const scored = searchRes.map(d => {
    // 1. Strict Movie vs TV filter (never match a TV series for a movie or vice versa)
    if (type === 'movie' && d.episodesCount > 1) {
      return { ...d, score: 0 };
    }
    if (type === 'tv' && d.episodesCount === 1 && !d.title.toLowerCase().includes('special')) {
      return { ...d, score: 0 };
    }

    let baseScore = calculateTitleScore(title, d.title);
    if (origTitle && origTitle !== title) {
      const origScore = calculateTitleScore(origTitle, d.title);
      if (origScore > baseScore) baseScore = origScore;
    }
    if (baseScore <= 0) return { ...d, score: 0 };

    // 2. Short titles (<= 2 words like 'Gifted', 'Dark') require release year verification
    const cleanWordCount = title.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(w => w.length > 1).length;
    if (cleanWordCount <= 2 && year) {
      const dYearMatch = d.title.match(/\b(19\d\d|20\d\d)\b/);
      if (dYearMatch && Math.abs(Number(dYearMatch[1]) - Number(year)) > 1) {
        return { ...d, score: 0 };
      }
    }
    let score = baseScore;
    if (type === 'movie' && d.episodesCount === 1) score += 0.10;
    if (type === 'movie' && year && d.title.includes(year)) score += 0.10;
    if (type === 'tv') {
      const dTitleLower = d.title.toLowerCase();
      if (season > 1 && (dTitleLower.includes(`season ${season}`) || dTitleLower.includes(`s${season}`))) score += 0.15;
      if (season === 1 && !(/season\s+[2-9]/i.test(dTitleLower))) score += 0.05;
    }
    return { ...d, score };
  }).filter(d => d.score >= 0.70).sort((a, b) => b.score - a.score);

  const bestMatch = scored[0];
  if (!bestMatch || bestMatch.score < 0.70) {
    throw new Error(`KissKH: Best title match score too low (${bestMatch ? bestMatch.score.toFixed(2) : 0}) for "${title}"`);
  }

  const dramaDetails = await fetchJson(`https://kisskh.is/api/DramaList/Drama/${bestMatch.id}?isq=false`);
  if (!dramaDetails || !dramaDetails.episodes || dramaDetails.episodes.length === 0) {
    throw new Error('KissKH: No episodes found');
  }

  let targetEpNum = type === 'movie' ? 1 : Number(episode);

  if (type === 'tv' && Number(season) > 1 && Array.isArray(tmdbData.seasons)) {
    let prevEps = 0;
    for (const s of tmdbData.seasons) {
      if (s.season_number > 0 && s.season_number < Number(season)) {
        prevEps += (s.episode_count || 0);
      }
    }
    const absoluteEpNum = prevEps + Number(episode);
    const hasAbsoluteEp = dramaDetails.episodes.some(e => e.number === absoluteEpNum);
    const candidateLower = bestMatch.title.toLowerCase();
    const isExplicitSeason = candidateLower.includes(`season ${season}`) || candidateLower.includes(`s${season}`);

    if (hasAbsoluteEp && !isExplicitSeason) {
      console.log(`[KissKH] Continuous episode mapping: S${season}:E${episode} -> Episode ${absoluteEpNum}`);
      targetEpNum = absoluteEpNum;
    }
  }

  const matchedEp = dramaDetails.episodes.find(e => e.number === targetEpNum) || dramaDetails.episodes[0];
  if (!matchedEp) throw new Error(`KissKH: Episode ${targetEpNum} not found`);

  const videoKkey = keyGenFn(matchedEp.id, VIDEO_GUID);
  const epDataUrl = `https://kisskh.is/api/DramaList/Episode/${matchedEp.id}.png?err=false&ts=null&time=null&kkey=${videoKkey}`;
  const epRes = await fetchJson(epDataUrl);

  if (!epRes || !epRes.Video) throw new Error('KissKH: Video URL not found in episode response');

  let subtitles = [];
  try {
    const subKkey = keyGenFn(matchedEp.id, SUB_GUID);
    const subUrl = `https://kisskh.is/api/Sub/${matchedEp.id}?kkey=${subKkey}`;
    const subRes = await fetchJson(subUrl);
    if (Array.isArray(subRes)) {
      subtitles = subRes.map((s, idx) => {
        const proxyUrl = `/api/subtitles/proxy?url=${encodeURIComponent(s.src)}&provider=kisskh`;
        return {
          id: `kisskh-sub-${idx}`,
          lang: s.land || 'en',
          label: s.label ? `${s.label} (KissKH)` : 'English (KissKH)',
          url: proxyUrl,
          src: proxyUrl,
          rawSrc: s.src,
          default: !!s.default,
        };
      });
    }
  } catch {}

  return {
    ok: true,
    provider: 'KissKH',
    streamType: 'hls',
    streamUrl: epRes.Video,
    subtitles,
  };
}

module.exports = { extractKisskhHttp };
