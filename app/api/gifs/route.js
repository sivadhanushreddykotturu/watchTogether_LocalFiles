import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_KLIPY_KEY = 'Mwft2l8yULIpjBclwfxk9C82TQ994nFTFA3EHAE3TUlVxMSVSOZyG4YLdvqf1kuH';

let cachedRedgifsToken = null;
let tokenExpiresAt = 0;

async function getRedgifsToken() {
  if (cachedRedgifsToken && Date.now() < tokenExpiresAt) {
    return cachedRedgifsToken;
  }
  try {
    const res = await fetch('https://api.redgifs.com/v2/auth/temporary', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    cachedRedgifsToken = data.token;
    tokenExpiresAt = Date.now() + 20 * 60 * 60 * 1000;
    return cachedRedgifsToken;
  } catch (e) {
    console.error('Failed to get RedGIFs token:', e);
    return null;
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').trim();
  const provider = (searchParams.get('provider') || 'klipy').toLowerCase();
  const klipyKey = process.env.KLIPY_API_KEY || process.env.NEXT_PUBLIC_KLIPY_API_KEY || DEFAULT_KLIPY_KEY;
  const giphyKey = process.env.GIPHY_API_KEY;

  // 1. RedGIFs (NSFW Provider)
  if (provider === 'redgifs') {
    try {
      const token = await getRedgifsToken();
      if (!token) {
        return NextResponse.json({ ok: false, error: 'Could not authenticate with RedGIFs', results: [] });
      }

      const searchTerm = q || 'trending';
      const endpoint = `https://api.redgifs.com/v2/gifs/search?search_text=${encodeURIComponent(searchTerm)}&count=30&order=trending`;

      const res = await fetch(endpoint, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        next: { revalidate: 60 }
      });

      if (!res.ok) {
        if (res.status === 404) {
          return NextResponse.json({ ok: true, provider: 'REDGIFS', results: [] });
        }
        return NextResponse.json({ ok: false, error: `RedGIFs returned ${res.status}`, results: [] });
      }

      const json = await res.json();
      const rawGifs = Array.isArray(json.gifs) ? json.gifs : [];

      const results = rawGifs.map((g) => {
        const poster = g.urls?.thumbnail || g.urls?.poster || '';
        const full = g.urls?.sd || g.urls?.hd || g.urls?.poster || poster;
        return {
          id: String(g.id || Math.random()),
          title: g.description || (Array.isArray(g.tags) && g.tags.length ? g.tags.slice(0, 3).join(', ') : 'RedGIF'),
          previewUrl: poster ? `/api/proxy/hls?url=${encodeURIComponent(poster)}` : full,
          url: full ? `/api/proxy/hls?url=${encodeURIComponent(full)}` : poster,
          rawUrl: full,
          width: g.width || 150,
          height: g.height || 150,
        };
      }).filter((item) => item.previewUrl && item.url);

      return NextResponse.json({ ok: true, provider: 'REDGIFS', results });
    } catch (err) {
      console.error('RedGIFs API error:', err);
      return NextResponse.json({ ok: false, error: err.message, results: [] });
    }
  }

  // 2. Primary Standard: KLIPY
  if (klipyKey) {
    try {
      const endpoint = q
        ? `https://api.klipy.com/api/v1/${klipyKey}/gifs/search?q=${encodeURIComponent(q)}&per_page=24&customer_id=reelsync_user&content_filter=off`
        : `https://api.klipy.com/api/v1/${klipyKey}/gifs/trending?per_page=24&customer_id=reelsync_user&content_filter=off`;

      const res = await fetch(endpoint, {
        headers: { 'Accept': 'application/json' },
        next: { revalidate: 30 },
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`KLIPY API error (${res.status}):`, errText);
        return NextResponse.json({
          ok: false,
          error: `KLIPY error (${res.status}): ${errText || 'Invalid API Key'}`,
          results: [],
        });
      }

      const json = await res.json();
      const rawList = Array.isArray(json.data?.data)
        ? json.data.data
        : Array.isArray(json.data)
        ? json.data
        : Array.isArray(json.results)
        ? json.results
        : [];

      const results = rawList.map((item) => {
        const file = item.file || {};
        const preview =
          file.sm?.webp?.url ||
          file.sm?.gif?.url ||
          file.xs?.webp?.url ||
          file.md?.webp?.url ||
          file.hd?.gif?.url ||
          item.preview ||
          item.url;

        const full =
          file.hd?.gif?.url ||
          file.md?.gif?.url ||
          file.sm?.gif?.url ||
          file.hd?.webp?.url ||
          preview;

        const width = file.sm?.webp?.width || file.sm?.gif?.width || file.hd?.gif?.width || 150;
        const height = file.sm?.webp?.height || file.sm?.gif?.height || file.hd?.gif?.height || 150;

        return {
          id: String(item.id || item.slug || Math.random()),
          title: item.title || item.slug || 'KLIPY GIF',
          previewUrl: preview || full,
          url: full || preview,
          width,
          height,
        };
      }).filter((item) => item.url);

      return NextResponse.json({ ok: true, provider: 'KLIPY', results });
    } catch (err) {
      console.error('KLIPY API error:', err);
      return NextResponse.json({ ok: false, error: err.message, results: [] });
    }
  }

  // 3. Fallback: GIPHY
  if (giphyKey) {
    try {
      const endpoint = q
        ? `https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(q)}&limit=24&rating=g`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${giphyKey}&limit=24&rating=g`;

      const res = await fetch(endpoint, {
        headers: { 'Accept': 'application/json' },
        next: { revalidate: 60 },
      });

      if (res.ok) {
        const json = await res.json();
        const results = (json.data || []).map((item) => ({
          id: item.id,
          title: item.title || 'GIF',
          previewUrl: item.images?.fixed_width?.webp || item.images?.fixed_width?.url || item.images?.original?.url,
          url: item.images?.original?.url || item.images?.downsized?.url,
          width: item.images?.fixed_width?.width || 150,
          height: item.images?.fixed_width?.height || 150,
        })).filter((item) => item.url);

        return NextResponse.json({ ok: true, provider: 'GIPHY', results });
      }
    } catch (err) {
      console.error('GIPHY fallback error:', err);
    }
  }

  return NextResponse.json({
    ok: false,
    needsKey: true,
    error: 'KLIPY API Key required. Set KLIPY_API_KEY in environment variables.',
    results: [],
  });
}
