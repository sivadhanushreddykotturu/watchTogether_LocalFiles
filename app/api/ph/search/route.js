import { NextResponse } from 'next/server';

function cleanText(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePornhubSearchHtml(html) {
  const results = [];
  const seen = new Set();

  const vkeyRegex = /viewkey=([a-zA-Z0-9]+)/g;
  const allVkeys = [...new Set([...html.matchAll(vkeyRegex)].map(m => m[1]))];

  for (const vkey of allVkeys) {
    if (seen.has(vkey)) continue;

    const idx = html.indexOf(vkey);
    if (idx === -1) continue;

    const snippet = html.substring(Math.max(0, idx - 300), Math.min(html.length, idx + 900));

    const titleMatch = snippet.match(/title="([^"]+)"/i) || snippet.match(/alt="([^"]+)"/i);
    const rawTitle = titleMatch ? cleanText(titleMatch[1]) : '';

    if (!rawTitle || rawTitle.toLowerCase() === 'pornhub' || rawTitle.toLowerCase().includes('upgrade now')) {
      continue;
    }

    const thumbMatch = snippet.match(/data-src="([^"]+)"/i)
      || snippet.match(/data-thumb_url="([^"]+)"/i)
      || snippet.match(/data-mediumthumb="([^"]+)"/i)
      || snippet.match(/src="(https:\/\/[^"]*phncdn[^"]+)"/i);
    const rawThumb = thumbMatch ? thumbMatch[1] : `https://ci.phncdn.com/videos/${vkey}/default.jpg`;
    const thumbnail = `/api/ph/thumb?url=${encodeURIComponent(rawThumb)}`;

    const durationMatch = snippet.match(/<var class="duration">([^<]+)<\/var>/i) || snippet.match(/<var[^>]*>([^<]+)<\/var>/i);
    const duration = durationMatch ? cleanText(durationMatch[1]) : '';

    const viewsMatch = snippet.match(/<span class="views">[\s\S]*?<var>([^<]+)<\/var>/i);
    const views = viewsMatch ? cleanText(viewsMatch[1]) : '';

    seen.add(vkey);
    results.push({
      id: vkey,
      viewkey: vkey,
      title: rawTitle,
      thumbnail,
      duration,
      views,
      embedUrl: `https://www.pornhub.org/embed/${vkey}`,
      url: `https://www.pornhub.com/view_video.php?viewkey=${vkey}`,
      platform: 'PH'
    });

    if (results.length >= 24) break;
  }

  return results;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || searchParams.get('search') || '').trim();
  const page = parseInt(searchParams.get('page') || '1', 10);

  if (!q) {
    return NextResponse.json({ ok: true, results: [] });
  }

  try {
    const searchUrl = `https://www.pornhub.com/video/search?search=${encodeURIComponent(q)}&page=${page}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': 'accessAgeDisclaimerPH=1; platform=pc; bs=1'
      },
      next: { revalidate: 300 }
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Pornhub returned status ${res.status}`, results: [] }, { status: res.status });
    }

    const html = await res.text();
    const results = parsePornhubSearchHtml(html);

    return NextResponse.json({ ok: true, results, count: results.length });
  } catch (err) {
    console.error('Pornhub search API error:', err);
    return NextResponse.json({ ok: false, error: 'Search request failed', results: [] }, { status: 500 });
  }
}
