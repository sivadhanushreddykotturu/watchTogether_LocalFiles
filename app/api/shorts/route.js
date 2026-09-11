import { NextResponse } from 'next/server';

// In-memory token cache (tokens last ~24 hours)
let cachedToken = null;
let tokenExpiresAt = 0;

async function getRedGifsToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  try {
    const res = await fetch('https://api.redgifs.com/v2/auth/temporary', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`Auth failed with status ${res.status}`);
    }
    const data = await res.json();
    if (data && data.token) {
      cachedToken = data.token;
      // Expire in 12 hours to be safe
      tokenExpiresAt = now + 12 * 60 * 60 * 1000;
      return cachedToken;
    }
    throw new Error('No token returned from RedGifs');
  } catch (err) {
    console.error('[redgifs-auth] Failed to get temporary token:', err);
    return null;
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const tag = (searchParams.get('tag') || searchParams.get('q') || '').trim();
  const order = searchParams.get('order') || 'trending';
  const page = parseInt(searchParams.get('page') || '1', 10);
  const count = parseInt(searchParams.get('count') || '25', 10);

  try {
    const token = await getRedGifsToken();
    if (!token) {
      return NextResponse.json({ ok: false, error: 'Could not authenticate with RedGifs' }, { status: 502 });
    }

    const searchQuery = tag || 'trending';
    const apiUrl = `https://api.redgifs.com/v2/gifs/search?search_text=${encodeURIComponent(searchQuery)}&order=${encodeURIComponent(order)}&count=${count}&page=${page}`;

    const res = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      // If token expired, clear cache and return error
      if (res.status === 401) {
        cachedToken = null;
        tokenExpiresAt = 0;
      }
      return NextResponse.json({ ok: false, error: `RedGifs API returned ${res.status}` }, { status: res.status });
    }

    const data = await res.json();
    const rawGifs = Array.isArray(data.gifs) ? data.gifs : [];

    // Sort to prioritize vertical orientation (9:16 reels style)
    const sorted = [...rawGifs].sort((a, b) => {
      const aVertical = (a.height || 0) >= (a.width || 0) ? 1 : 0;
      const bVertical = (b.height || 0) >= (b.width || 0) ? 1 : 0;
      return bVertical - aVertical;
    });

    const clips = sorted.map((g) => {
      const urls = g.urls || {};
      const hdUrl = urls.hd || urls.sd || '';
      const sdUrl = urls.sd || urls.hd || '';
      const poster = urls.poster || urls.thumbnail || '';
      const thumbnail = urls.thumbnail || urls.poster || '';

      // Direct clean author & caption
      const author = g.userName || 'Creator';
      const title = g.description || (g.tags && g.tags.length > 0 ? `#${g.tags.slice(0, 3).join(' #')}` : 'Short Reel');

      return {
        id: g.id,
        title,
        author,
        authorProfile: g.userName ? `https://www.redgifs.com/users/${g.userName}` : null,
        hdUrl,
        sdUrl,
        // Prefer sd for rapid mobile preloading, hd for crisp desktop
        url: sdUrl || hdUrl,
        poster,
        thumbnail,
        duration: Number(g.duration) || 15,
        width: g.width,
        height: g.height,
        isVertical: (g.height || 0) >= (g.width || 0),
        views: g.views || 0,
        likes: g.likes || 0,
        tags: Array.isArray(g.tags) ? g.tags.slice(0, 5) : [],
        platform: 'RedGifs',
      };
    }).filter((c) => c.url);

    return NextResponse.json({
      ok: true,
      clips,
      count: clips.length,
      page,
      hasMore: clips.length >= 10,
    });
  } catch (err) {
    console.error('[shorts-api] Error:', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
