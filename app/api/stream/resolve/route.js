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
      return NextResponse.json({
        ok: true,
        cached: true,
        streamUrl: cached.streamUrl,
        rawUrl: cached.rawUrl,
        streamType: cached.streamType,
        provider: cached.provider,
      });
    }
  } catch (err) {
    console.warn('MongoDB cache check warning:', err.message);
  }

  // 2. Query parallel background daemon on port 4545
  try {
    const qs = new URLSearchParams({
      id: String(id),
      type,
      s: String(season),
      e: String(episode),
    });

    const daemonRes = await fetch(`http://localhost:4545/resolve?${qs.toString()}`, {
      signal: AbortSignal.timeout(9000),
    });

    if (daemonRes.ok) {
      const data = await daemonRes.json();
      if (data.ok && data.streamUrl) {
        let finalStreamUrl = data.streamUrl;

        // If HLS (.m3u8), proxy through Cloudflare Worker to bypass 403 referer blocks
        if (data.streamType === 'hls' || data.streamUrl.includes('.m3u8')) {
          finalStreamUrl = `https://d.ksdhanushreddy.workers.dev/proxy?url=${encodeURIComponent(data.streamUrl)}`;
        }

        const streamResult = {
          streamUrl: finalStreamUrl,
          rawUrl: data.streamUrl,
          streamType: data.streamType || (finalStreamUrl.includes('.mpd') ? 'dash' : 'hls'),
          provider: data.provider || 'VidFast',
        };

        // 3. Save to MongoDB so everyone in the room & future visitors play instantly
        db.saveStreamCache(mediaKey, streamResult).catch(() => {});

        console.log(`[Stream API] Resolved and cached in MongoDB: ${mediaKey} -> ${streamResult.provider} (${streamResult.streamType})`);

        return NextResponse.json({
          ok: true,
          cached: false,
          ...streamResult,
        });
      }
    }
  } catch (err) {
    console.warn('Stream resolver daemon unavailable:', err.message);
  }

  return NextResponse.json({ ok: false, error: 'Failed to extract stream from providers' }, { status: 504 });
}
