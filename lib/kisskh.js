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
  const cleanTarget = (targetTitle || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanCandidate = (candidateTitle || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  if (cleanTarget === cleanCandidate) return 1.0;

  const stopWords = new Set(['a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is']);
  const targetWords = cleanTarget.split(' ').filter(w => w.length > 0 && !stopWords.has(w));
  const candidateWords = new Set(cleanCandidate.split(' ').filter(w => w.length > 0 && !stopWords.has(w)));

  if (targetWords.length === 0) return 0;

  let matched = 0;
  for (const word of targetWords) {
    if (candidateWords.has(word)) matched++;
  }

  return matched / targetWords.length;
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
    let score = calculateTitleScore(title, d.title);
    if (origTitle && origTitle !== title) {
      const origScore = calculateTitleScore(origTitle, d.title);
      if (origScore > score) score = origScore;
    }
    if (type === 'movie' && d.episodesCount === 1) score += 0.15;
    if (type === 'movie' && year && d.title.includes(year)) score += 0.15;
    if (type === 'tv') {
      const dTitleLower = d.title.toLowerCase();
      if (season > 1 && (dTitleLower.includes(`season ${season}`) || dTitleLower.includes(`s${season}`))) score += 0.2;
      if (season === 1 && !(/season\s+[2-9]/i.test(dTitleLower))) score += 0.1;
    }
    return { ...d, score };
  }).sort((a, b) => b.score - a.score);

  const bestMatch = scored[0];
  if (!bestMatch || bestMatch.score < 0.60) {
    throw new Error(`KissKH: Best title match score too low (${bestMatch ? bestMatch.score.toFixed(2) : 0}) for "${title}"`);
  }

  const dramaDetails = await fetchJson(`https://kisskh.is/api/DramaList/Drama/${bestMatch.id}?isq=false`);
  if (!dramaDetails || !dramaDetails.episodes || dramaDetails.episodes.length === 0) {
    throw new Error('KissKH: No episodes found');
  }

  const targetEpNum = type === 'movie' ? 1 : Number(episode);
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
      subtitles = subRes.map((s, idx) => ({
        id: `kisskh-sub-${idx}`,
        lang: s.land || 'en',
        label: s.label ? `${s.label} (KissKH)` : 'English (KissKH)',
        url: s.src,
        src: s.src,
        default: !!s.default,
      }));
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
