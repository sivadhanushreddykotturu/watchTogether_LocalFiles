
import { NextResponse } from 'next/server';
import db from '@/db';
import { extractVidlinkHttp } from '@/lib/vidlink';
import { extractKisskhHttp } from '@/lib/kisskh';

function shouldProxyStream(url, provider) {
  if (!url) return false;
  // If already proxied
  if (url.startsWith('https://d.ksdhanushreddy.workers.dev/proxy')) return false;
  // DASH streams are direct signed CloudFront manifests (sacdn)
  if (url.includes('.mpd')) return false;
  // CineSrc has open CORS and blocks Cloudflare Worker with 502/dontscrape
  if (provider === 'CineSrc' || url.includes('cinesrc.st') || url.includes('bright67.online')) return false;
  return true;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const type = searchParams.get('type') || 'movie';
    const season = searchParams.get('s') || searchParams.get('season') || '1';
    const episode = searchParams.get('e') || searchParams.get('episode') || '1';
    const fallbackParam = (searchParams.get('fallback') || searchParams.get('provider') || '').toLowerCase();
    const forceKisskh = fallbackParam === 'kisskh' || searchParams.get('skip') === 'vidlink';

    if (!id) {
      return NextResponse.json({ ok: false, error: 'Missing TMDB ID' }, { status: 400 });
    }

    const mediaKey = type === 'tv' ? `tv:${id}:${season}:${episode}` : `movie:${id}`;

    // 1. Check MongoDB cache first (instant 0ms response, no scraping)
    try {
      const cached = await db.getStreamCache(mediaKey);
      if (cached && cached.streamUrl) {
        if (forceKisskh && cached.provider !== 'KissKH') {
          console.log(`[Stream API] Skipping cached ${cached.provider} stream because KissKH fallback requested.`);
        } else {
          console.log(`[Stream API] ⚡ Cache HIT in MongoDB for ${mediaKey} (${cached.provider})`);
          let streamUrl = cached.streamUrl;
          if (shouldProxyStream(streamUrl, cached.provider)) {
            streamUrl = `https://d.ksdhanushreddy.workers.dev/proxy?url=${encodeURIComponent(streamUrl)}`;
          }

          const subtitles = Array.isArray(cached.subtitles)
            ? cached.subtitles.map(s => ({
                id: String(s.id || ''),
                lang: String(s.lang || ''),
                label: String(s.label || ''),
                url: String(s.url || ''),
                src: String(s.src || s.url || ''),
                rawSrc: String(s.rawSrc || ''),
                default: Boolean(s.default),
              }))
            : [];

          return NextResponse.json({
            ok: true,
            cached: true,
            streamUrl,
            rawUrl: cached.rawUrl || cached.streamUrl,
            streamType: cached.streamType,
            provider: cached.provider,
            codec: cached.codec || 'h264',
            subtitles,
          });
        }
      }
    } catch (err) {
      console.warn('MongoDB cache check warning:', err.message);
    }

  let resolvedData = null;
  const startTime = Date.now();

  if (forceKisskh) {
    try {
      const kisskhRes = await extractKisskhHttp(id, type, season, episode);
      if (kisskhRes && kisskhRes.ok && kisskhRes.streamUrl) {
        console.log(`[Stream API] ⚡ KissKH Direct Fallback Match for ${mediaKey}`);
        resolvedData = kisskhRes;
      }
    } catch (err) {
      console.warn('[Stream API] KissKH direct error:', err.message);
    }
  } else {
  // 2. Query Primary 1080p Providers (Pure HTTP VidLink on server + Local Resolver daemon for CineSrc/VidFast)
  const primaryPromises = [];

  // Pure HTTP VidLink (runs directly on server in ~500ms, 0 Chrome, works 24/7 on any device)
  try {
    primaryPromises.push(extractVidlinkHttp(id, type, season, episode).catch(() => null));
  } catch (e) {
    console.warn('[Stream API] VidLink execution error:', e.message);
  }

  // Local Resolver daemon (if running on developer laptop or internal sidecar)
  if (typeof global !== 'undefined' && typeof global.__reelsync_resolve === 'function') {
    primaryPromises.push(global.__reelsync_resolve({ id, type, s: season, e: episode, timeoutMs: 12000 }).catch(() => null));
  } else {
    const qs = new URLSearchParams({ id: String(id), type, s: String(season), e: String(episode) });
    primaryPromises.push(
      fetch(`http://localhost:4545/resolve?${qs.toString()}`, { signal: AbortSignal.timeout(6000) })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    );
  }

  // 3. First non-null winner among primary providers wins immediately (usually VidLink in <1s)
  // Wrapped in a strict 5.0-second priority window
  const fiveSecTimeout = new Promise(resolve => setTimeout(() => resolve(null), 5000));
  
  const raceFirstValid = (promises) => new Promise(resolve => {
    let pending = promises.length;
    if (pending === 0) return resolve(null);
    for (const p of promises) {
      Promise.resolve(p).then(res => {
        if (res && res.ok && res.streamUrl) {
          resolve(res);
        } else {
          pending--;
          if (pending === 0) resolve(null);
        }
      }).catch(() => {
        pending--;
        if (pending === 0) resolve(null);
      });
    }
  });

  try {
    const fastWinner = await Promise.race([raceFirstValid(primaryPromises), fiveSecTimeout]);
    if (fastWinner && fastWinner.ok && fastWinner.streamUrl) {
      console.log(`[Stream API] ⚡ Primary 1080p Winner: ${fastWinner.provider} (${fastWinner.streamType})`);
      resolvedData = fastWinner;
    }
  } catch (err) {
    console.warn('[Stream API] Primary race error:', err.message);
  }

  // 4. Fallback: If 5.0 seconds elapsed and primary hasn't returned yet, query KissKH fallback
  if (!resolvedData) {
    const elapsed = Date.now() - startTime;
    if (elapsed < 5000) {
      await new Promise(r => setTimeout(r, 5000 - elapsed));
    }

    try {
      const kisskhRes = await extractKisskhHttp(id, type, season, episode);
      if (kisskhRes && kisskhRes.ok && kisskhRes.streamUrl) {
        console.log(`[Stream API] ⚡ KissKH Fallback Match for ${mediaKey}`);
        resolvedData = kisskhRes;
      }
    } catch (err) {
      // Not on KissKH or rejected by strict title/type match
    }
  }
  }

  // 4. If stream extracted, prepare and cache in MongoDB Atlas
  if (resolvedData && resolvedData.streamUrl) {
    let finalStreamUrl = resolvedData.streamUrl;

    // Proxy streams through Cloudflare Worker (VidFast / KissKH) to rewrite manifests & bypass 403 blocks
    if (shouldProxyStream(resolvedData.streamUrl, resolvedData.provider)) {
      finalStreamUrl = `https://d.ksdhanushreddy.workers.dev/proxy?url=${encodeURIComponent(resolvedData.streamUrl)}`;
    }

    const streamResult = {
      streamUrl: finalStreamUrl,
      rawUrl: resolvedData.streamUrl,
      streamType: resolvedData.streamType || (finalStreamUrl.includes('.mpd') ? 'dash' : 'hls'),
      provider: resolvedData.provider || 'VidLink',
      codec: resolvedData.codec || (finalStreamUrl.includes('.mpd') ? (resolvedData.codec || 'h264') : 'h264'),
      subtitles: resolvedData.subtitles || [],
    };

    // Save to MongoDB so everyone in the room & future visitors play in 0ms
    try {
      await db.saveStreamCache(mediaKey, streamResult);
      console.log(`[Stream API] ⚡ Resolved and saved to MongoDB: ${mediaKey} -> ${streamResult.provider}`);
    } catch (err) {
      console.warn('[Stream API] MongoDB save warning:', err.message);
    }

    return NextResponse.json({
      ok: true,
      cached: false,
      ...streamResult,
    });
  }

  return NextResponse.json({ ok: false, error: 'Failed to extract stream from providers' }, { status: 404 });
  } catch (err) {
    console.error('[Stream API Error]:', err);
    return NextResponse.json({ ok: false, error: err.message || 'Internal server error' }, { status: 500 });
  }
}
