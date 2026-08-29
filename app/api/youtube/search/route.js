import { NextResponse } from 'next/server';

function parsePublicResults(html) {
  const results = [];
  try {
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/s);
    if (!match) return results;

    const data = JSON.parse(match[1]);
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

    for (const section of sections) {
      const items = section?.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const vr = item.videoRenderer;
        if (!vr || !vr.videoId) continue;

        const id = vr.videoId;
        const title = vr.title?.runs?.map(r => r.text).join('') || vr.title?.simpleText || 'YouTube Video';
        const author = vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || '';
        const thumbnails = vr.thumbnail?.thumbnails || [];
        const thumbnail = thumbnails.length > 0
          ? thumbnails[thumbnails.length - 1].url
          : `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
        const duration = vr.lengthText?.simpleText || vr.lengthText?.runs?.map(r => r.text).join('') || '';
        const views = vr.shortViewCountText?.simpleText || vr.viewCountText?.simpleText || '';

        results.push({
          id,
          title,
          author,
          thumbnail,
          duration,
          views,
        });

        if (results.length >= 20) break;
      }
      if (results.length >= 20) break;
    }
  } catch (err) {
    console.error('Error parsing YouTube HTML:', err);
  }
  return results;
}

async function searchWithApiKey(query, apiKey, gl = 'IN', hl = 'en-GB') {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=20&q=${encodeURIComponent(query)}&regionCode=${gl}&relevanceLanguage=${hl.split('-')[0]}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`YouTube API returned ${res.status}`);
  }
  const data = await res.json();
  return (data.items || []).map(item => ({
    id: item.id?.videoId,
    title: item.snippet?.title || 'YouTube Video',
    author: item.snippet?.channelTitle || '',
    thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || `https://img.youtube.com/vi/${item.id?.videoId}/mqdefault.jpg`,
    duration: '',
    views: '',
  })).filter(item => item.id);
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').trim();
  const gl = (searchParams.get('gl') || 'IN').toUpperCase();
  const hl = searchParams.get('hl') || 'en-GB';

  if (!q) {
    return NextResponse.json({ results: [] });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;

  if (apiKey) {
    try {
      const results = await searchWithApiKey(q, apiKey, gl, hl);
      if (results.length > 0) {
        return NextResponse.json({ results });
      }
    } catch (err) {
      console.warn('YouTube API Key search failed, falling back to public search:', err.message);
    }
  }

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&gl=${gl}&hl=${hl}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': `${hl},en-IN;q=0.9,en;q=0.8,te;q=0.7,hi;q=0.6`,
      },
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch YouTube search' }, { status: res.status });
    }

    const html = await res.text();
    const results = parsePublicResults(html);

    return NextResponse.json({ results });
  } catch (err) {
    console.error('YouTube search error:', err);
    return NextResponse.json({ error: 'Search failed', results: [] }, { status: 500 });
  }
}
