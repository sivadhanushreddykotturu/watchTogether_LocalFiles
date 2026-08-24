import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rawInput = searchParams.get('viewkey') || searchParams.get('url') || '';
  const s = rawInput.trim();
  if (!s) {
    return NextResponse.json({ ok: false, error: 'Missing viewkey or url' }, { status: 400 });
  }

  // Extract viewkey
  let viewkey = s;
  const match = s.match(/(?:view_video\.php\?viewkey=|embed\/|^)([a-zA-Z0-9]+)/i);
  if (match) {
    viewkey = match[1];
  }

  try {
    const targetUrl = `https://www.pornhub.com/view_video.php?viewkey=${viewkey}`;
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': 'accessAgeDisclaimerPH=1; age_verified=1;',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `PH returned status ${res.status}` }, { status: res.status });
    }

    const html = await res.text();
    const flashvarsMatch = html.match(/flashvars_\d+\s*=\s*({.+?});/);
    if (!flashvarsMatch) {
      return NextResponse.json({ ok: false, error: 'Could not extract video stream' }, { status: 404 });
    }

    const flashvars = JSON.parse(flashvarsMatch[1]);
    const title = flashvars.video_title || 'PH Video';
    const duration = Number(flashvars.video_duration) || 0;
    const mediaDefs = Array.isArray(flashvars.mediaDefinitions) ? flashvars.mediaDefinitions : [];

    // Filter for HLS formats with videoUrl
    const hlsItems = mediaDefs.filter((m) => m.format === 'hls' && m.videoUrl);
    // Sort descending by height/quality
    hlsItems.sort((a, b) => (Number(b.quality) || Number(b.height) || 0) - (Number(a.quality) || Number(a.height) || 0));

    const bestStream = hlsItems[0];
    if (!bestStream) {
      return NextResponse.json({ ok: false, error: 'No HLS streams found for this video' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      viewkey,
      title,
      duration,
      hlsUrl: `/api/ph/stream?url=${encodeURIComponent(bestStream.videoUrl)}`,
      qualities: hlsItems.map((m) => ({
        quality: String(m.quality || m.height || 'Auto'),
        url: `/api/ph/stream?url=${encodeURIComponent(m.videoUrl)}`,
      })),
      platform: 'PH',
    });
  } catch (err) {
    console.error('PH extractor error:', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
