
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
import { NextResponse } from 'next/server';
const db = require('@/db');

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const type = searchParams.get('type') || 'movie';
  const season = searchParams.get('s') || searchParams.get('season') || '1';
  const episode = searchParams.get('e') || searchParams.get('episode') || '1';

  if (!id) {
    return NextResponse.json({ ok: false, error: 'Missing TMDB ID' }, { status: 400 });
  }

  const mediaKey = type === 'tv' ? `tv:${id}:${season}:${episode}` : `movie:${id}`;

  // 1. Check MongoDB cache first (instant 0ms response, no scraping)
  try {
    const cached = await db.getStreamCache(mediaKey);
    if (cached && cached.streamUrl) {
      console.log(`[Stream API] ⚡ Cache HIT in MongoDB for ${mediaKey} (${cached.provider})`);
      let streamUrl = cached.streamUrl;
      if (shouldProxyStream(streamUrl, cached.provider)) {
        streamUrl = `https://d.ksdhanushreddy.workers.dev/proxy?url=${encodeURIComponent(streamUrl)}`;
      }
      return NextResponse.json({
        ok: true,
        cached: true,
        streamUrl,
        rawUrl: cached.rawUrl || cached.streamUrl,
        streamType: cached.streamType,
        provider: cached.provider,
        subtitles: cached.subtitles || [],
      });
    }
  } catch (err) {
    console.warn('MongoDB cache check warning:', err.message);
  }

  let resolvedData = null;
  const startTime = Date.now();
  let primaryPromise = null;

  // 2. Query Primary 1080p Providers (VidLink / CineSrc / VidFast) with strict 5-second priority race
  if (typeof global !== 'undefined' && typeof global.__reelsync_resolve === 'function') {
    console.log(`[Stream API] ⚡ Launching primary 1080p providers for ${mediaKey}...`);
    primaryPromise = global.__reelsync_resolve({ id, type, s: season, e: episode, timeoutMs: 12000 });
  } else {
    const qs = new URLSearchParams({ id: String(id), type, s: String(season), e: String(episode) });
    primaryPromise = fetch(`http://localhost:4545/resolve?${qs.toString()}`, { signal: AbortSignal.timeout(6000) })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  }

  // 3. Wait up to 5.0 seconds for primary 1080p providers on EVERY device
  if (primaryPromise) {
    try {
      const fiveSecTimeout = new Promise(resolve => setTimeout(() => resolve(null), 5000));
      const fastWinner = await Promise.race([primaryPromise, fiveSecTimeout]);
      if (fastWinner && fastWinner.ok && fastWinner.streamUrl) {
        console.log(`[Stream API] ⚡ Primary 1080p Winner: ${fastWinner.provider} (${fastWinner.streamType})`);
        resolvedData = fastWinner;
      }
    } catch (err) {
      console.warn('[Stream API] Primary race error:', err.message);
    }
  }

  // 4. Fallback: If 5.0 seconds elapsed and primary hasn't returned yet, query KissKH fallback
  if (!resolvedData) {
    const elapsed = Date.now() - startTime;
    if (elapsed < 5000) {
      await new Promise(r => setTimeout(r, 5000 - elapsed));
    }

    if (primaryPromise) {
      const lateWinner = await Promise.race([primaryPromise, Promise.resolve(null)]);
      if (lateWinner && lateWinner.ok && lateWinner.streamUrl) {
        resolvedData = lateWinner;
      }
    }

    if (!resolvedData) {
      try {
        const { extractKisskhHttp } = require('@/lib/kisskh');
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

  return NextResponse.json({ ok: false, error: 'Failed to extract stream from providers' }, { status: 504 });
}
