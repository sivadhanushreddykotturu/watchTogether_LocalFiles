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

  // 1. Isolate the search results container
  let searchHtml = '';
  const searchContainerMatch = html.match(/<ul[^>]*id="videoSearchResult"[^>]*>([\s\S]*?)<\/ul>/i)
    || html.match(/<ul[^>]*class="[^"]*search-video-thumbs[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);

  if (searchContainerMatch) {
    searchHtml = searchContainerMatch[1];
  } else {
    searchHtml = html
      .replace(/<ul[^>]*id="hottestMenuSection"[\s\S]*?<\/ul>/gi, '')
      .replace(/<ul[^>]*id="recommMenuSection"[\s\S]*?<\/ul>/gi, '')
      .replace(/<ul[^>]*id="playListHeaderSection"[\s\S]*?<\/ul>/gi, '')
      .replace(/<ul[^>]*id="bottomVideos"[\s\S]*?<\/ul>/gi, '')
      .replace(/<div[^>]*id="hottestMenuSection"[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*id="recommMenuSection"[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*id="playListHeaderSection"[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*id="bottomVideos"[\s\S]*?<\/div>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '');
  }

  // 2. Extract each video item inside the search container
  const liBlocks = searchHtml.match(/<li[\s\S]*?<\/li>/gi) || [];

  for (const block of liBlocks) {
    // Check for viewkey
    const vkeyMatch = block.match(/data-video-vkey="([a-zA-Z0-9]+)"/i)
      || block.match(/viewkey=([a-zA-Z0-9]+)/i);
    if (!vkeyMatch) continue;
    const vkey = vkeyMatch[1];
    if (seen.has(vkey)) continue;

    // Title
    const titleMatch = block.match(/<span class="title"[^>]*>[\s\S]*?<a[^>]*title="([^"]+)"/i)
      || block.match(/<a[^>]*class="[^"]*thumbnailTitle[^"]*"[^>]*title="([^"]+)"/i)
      || block.match(/<a[^>]*title="([^"]+)"/i)
      || block.match(/title="([^"]+)"/i);
    const rawTitle = titleMatch ? cleanText(titleMatch[1]) : '';

    if (!rawTitle || rawTitle.toLowerCase() === 'pornhub' || rawTitle.toLowerCase().includes('upgrade now') || rawTitle.toLowerCase().includes('remove ads')) {
      continue;
    }

    // Thumbnail
    const thumbUrlMatch = block.match(/data-mediumthumb="([^"]+)"/i)
      || block.match(/data-thumb_url="([^"]+)"/i)
      || block.match(/data-image="([^"]+)"/i)
      || block.match(/data-src="([^"]+)"/i)
      || block.match(/https?:\/\/[a-zA-Z0-9.-]*phncdn\.com\/[^"'\s<>]+\.(?:jpg|jpeg|webp|png)(?:\?[^"'\s<>]*)?/i)
      || block.match(/src="([^"]*phncdn[^"]*)"/i);

    let rawThumb = thumbUrlMatch ? (thumbUrlMatch[1] || thumbUrlMatch[0]) : '';
    if (rawThumb.startsWith('//')) rawThumb = 'https:' + rawThumb;
    if (rawThumb.includes('ci.phncdn.com')) {
      rawThumb = rawThumb.replace('ci.phncdn.com', 'ei.phncdn.com');
    }
    const thumbnail = rawThumb ? `/api/ph/thumb?url=${encodeURIComponent(rawThumb)}` : '';

    // Duration
    const durationMatch = block.match(/<var[^>]*class="[^"]*duration[^"]*"[^>]*>([^<]+)<\/var>/i)
      || block.match(/class="duration"[^>]*>([^<]+)<\/var>/i)
      || block.match(/<var[^>]*>([^<]+)<\/var>/i);
    const duration = durationMatch ? cleanText(durationMatch[1]) : '';

    // Views
    const viewsMatch = block.match(/<span class="views"[^>]*>[\s\S]*?<var>([^<]+)<\/var>/i)
      || block.match(/<span class="views"[^>]*>([^<]+)<\/span>/i)
      || block.match(/<var[^>]*>([0-9.]+[KMB]?)<\/var>/i);
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
      url: `https://www.pornhub.org/view_video.php?viewkey=${vkey}`,
      platform: 'PH'
    });

    if (results.length >= 32) break;
  }

  // Fallback if list regex didn't extract items
  if (results.length === 0) {
    const vkeyRegex = /viewkey=([a-zA-Z0-9]+)/g;
    const allVkeys = [...new Set([...searchHtml.matchAll(vkeyRegex)].map(m => m[1]))];

    for (const vkey of allVkeys) {
      if (seen.has(vkey)) continue;

      const idx = searchHtml.indexOf(`viewkey=${vkey}`);
      if (idx === -1) continue;

      const snippet = searchHtml.substring(Math.max(0, idx - 500), Math.min(searchHtml.length, idx + 3500));
      const titleMatch = snippet.match(/<span class="title"[^>]*>[\s\S]*?<a[^>]*title="([^"]+)"/i)
        || snippet.match(/title="([^"]+)"/i)
        || snippet.match(/alt="([^"]+)"/i);
      const rawTitle = titleMatch ? cleanText(titleMatch[1]) : '';

      if (!rawTitle || rawTitle.toLowerCase() === 'pornhub' || rawTitle.toLowerCase().includes('upgrade now') || rawTitle.toLowerCase().includes('remove ads')) {
        continue;
      }

      const thumbUrlMatch = snippet.match(/data-thumb_url="([^"]+)"/i)
        || snippet.match(/data-src="([^"]+)"/i)
        || snippet.match(/data-mediumthumb="([^"]+)"/i)
        || snippet.match(/data-image="([^"]+)"/i)
        || snippet.match(/https?:\/\/[a-zA-Z0-9.-]*phncdn\.com\/[^"'\s<>]+\.(?:jpg|jpeg|webp|png)(?:\?[^"'\s<>]*)?/i)
        || snippet.match(/src="([^"]*phncdn[^"]*)"/i);

      let rawThumb = thumbUrlMatch ? (thumbUrlMatch[1] || thumbUrlMatch[0]) : '';
      if (rawThumb.startsWith('//')) rawThumb = 'https:' + rawThumb;
      if (rawThumb.includes('ci.phncdn.com')) {
        rawThumb = rawThumb.replace('ci.phncdn.com', 'ei.phncdn.com');
      }
      const thumbnail = rawThumb ? `/api/ph/thumb?url=${encodeURIComponent(rawThumb)}` : '';

      const durationMatch = snippet.match(/<var[^>]*class="duration"[^>]*>([^<]+)<\/var>/i)
        || snippet.match(/class="duration"[^>]*>([^<]+)<\/var>/i)
        || snippet.match(/<var[^>]*>([^<]+)<\/var>/i);
      const duration = durationMatch ? cleanText(durationMatch[1]) : '';

      const viewsMatch = snippet.match(/<span class="views"[^>]*>[\s\S]*?<var>([^<]+)<\/var>/i)
        || snippet.match(/<span class="views"[^>]*>([^<]+)<\/span>/i)
        || snippet.match(/<var[^>]*>([0-9.]+[KMB]?)<\/var>/i);
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
        url: `https://www.pornhub.org/view_video.php?viewkey=${vkey}`,
        platform: 'PH'
      });

      if (results.length >= 32) break;
    }
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
    const canonicalQuery = q.toLowerCase();
    const searchUrl = `https://www.pornhub.org/video/search?search=${encodeURIComponent(canonicalQuery)}&page=${page}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': 'accessAgeDisclaimerPH=1; platform=pc; bs=1'
      },
      redirect: 'follow',
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
