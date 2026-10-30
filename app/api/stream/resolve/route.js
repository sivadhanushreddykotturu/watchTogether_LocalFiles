
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

  // 2. Query connected Local Resolver Daemon via WebSocket bridge
  if (typeof global !== 'undefined' && typeof global.__reelsync_resolve === 'function') {
    try {
      console.log(`[Stream API] ⚡ Requesting stream from connected resolver bridge for ${mediaKey}...`);
      const bridgeRes = await global.__reelsync_resolve({ id, type, s: season, e: episode, timeoutMs: 12000 });
      if (bridgeRes && bridgeRes.ok && bridgeRes.streamUrl) {
        resolvedData = bridgeRes;
      }
    } catch (err) {
      console.warn('[Stream API] Resolver bridge query error:', err.message);
    }
  }

  // 3. Fallback: Query local daemon on port 4545 (if running on same host)
  if (!resolvedData) {
    try {
      const qs = new URLSearchParams({
        id: String(id),
        type,
        s: String(season),
        e: String(episode),
      });

      const daemonRes = await fetch(`http://localhost:4545/resolve?${qs.toString()}`, {
        signal: AbortSignal.timeout(5000),
      });

      if (daemonRes.ok) {
        const data = await daemonRes.json();
        if (data.ok && data.streamUrl) {
          resolvedData = data;
        }
      }
    } catch (err) {
      // Local daemon unavailable or timed out
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
