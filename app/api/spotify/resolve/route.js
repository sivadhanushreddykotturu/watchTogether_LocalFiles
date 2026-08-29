import { NextResponse } from 'next/server';

function parsePublicYouTube(html) {
  try {
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/s);
    if (!match) return null;

    const data = JSON.parse(match[1]);
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

    for (const section of sections) {
      const items = section?.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const vr = item.videoRenderer;
        if (vr && vr.videoId) {
          return {
            videoId: vr.videoId,
            title: vr.title?.runs?.map(r => r.text).join('') || vr.title?.simpleText || '',
            author: vr.ownerText?.runs?.[0]?.text || '',
            duration: vr.lengthText?.simpleText || '',
          };
        }
      }
    }
  } catch (err) {
    console.error('Error parsing YouTube for Spotify resolution:', err);
  }
  return null;
}

async function findAudioBridge(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&regionCode=IN&relevanceLanguage=en&key=${apiKey}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const item = data.items?.[0];
        if (item?.id?.videoId) {
          return {
            videoId: item.id.videoId,
            title: item.snippet.title,
            author: item.snippet.channelTitle,
          };
        }
      }
    } catch (e) {
      console.warn('API key audio bridge failed:', e);
    }
  }

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&gl=IN&hl=en-GB`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-GB,en-IN;q=0.9,en;q=0.8,te;q=0.7,hi;q=0.6',
      },
    });
    if (res.ok) {
      const html = await res.text();
      return parsePublicYouTube(html);
    }
  } catch (err) {
    console.error('Public YouTube bridge search error:', err);
  }
  return null;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rawUrl = (searchParams.get('url') || '').trim();
  const rawTitle = (searchParams.get('title') || '').trim();
  const rawAuthor = (searchParams.get('author') || '').trim();
  const rawThumbnail = (searchParams.get('thumbnail') || '').trim();

  let trackTitle = rawTitle;
  let trackAuthor = rawAuthor;
  let trackThumbnail = rawThumbnail;
  let spotifyId = null;

  // If a Spotify URL is passed, extract metadata using Spotify oEmbed
  if (rawUrl && rawUrl.includes('spotify.com')) {
    const idMatch = rawUrl.match(/(?:track|album|playlist)[\/:]([a-zA-Z0-9]+)/);
    if (idMatch) spotifyId = idMatch[1];

    try {
      const oembedRes = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(rawUrl)}`);
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        trackTitle = oembed.title || trackTitle || 'Spotify Track';
        trackThumbnail = oembed.thumbnail_url || trackThumbnail;
        if (!trackAuthor && oembed.html) {
          const authorMatch = oembed.html.match(/by\s+([^<]+)/i);
          if (authorMatch) trackAuthor = authorMatch[1].trim();
        }
      }
    } catch (e) {
      console.warn('Spotify oEmbed fetch failed:', e);
    }
  }

  if (!trackTitle && !rawUrl) {
    return NextResponse.json({ ok: false, error: 'Missing track information' }, { status: 400 });
  }

  const query = `${trackTitle} ${trackAuthor} audio`.trim();
  const bridge = await findAudioBridge(query);

  if (!bridge || !bridge.videoId) {
    return NextResponse.json({ ok: false, error: 'Could not resolve audio stream for track' }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    type: 'youtube',
    platform: 'Spotify',
    spotifyId,
    title: trackTitle || bridge.title,
    author: trackAuthor || bridge.author,
    thumbnail: trackThumbnail || `https://img.youtube.com/vi/${bridge.videoId}/mqdefault.jpg`,
    videoId: bridge.videoId,
    duration: bridge.duration || '',
    url: rawUrl || `https://open.spotify.com/track/${spotifyId}`,
  });
}
