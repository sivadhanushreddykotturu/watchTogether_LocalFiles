import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').trim();
  const klipyKey = process.env.KLIPY_API_KEY || process.env.NEXT_PUBLIC_KLIPY_API_KEY;
  const giphyKey = process.env.GIPHY_API_KEY;

  // 1. If KLIPY key is configured (Primary)
  if (klipyKey) {
    try {
      const endpoint = q
        ? `https://api.klipy.com/api/v1/${klipyKey}/gifs/search?q=${encodeURIComponent(q)}&per_page=24`
        : `https://api.klipy.com/api/v1/${klipyKey}/gifs/trending?per_page=24`;

      const res = await fetch(endpoint, {
        headers: { 'Accept': 'application/json' },
        next: { revalidate: 60 },
      });

      if (res.ok) {
        const json = await res.json();
        const rawList = Array.isArray(json.data?.data)
          ? json.data.data
          : Array.isArray(json.data)
          ? json.data
          : Array.isArray(json.results)
          ? json.results
          : [];

        const results = rawList.map((item) => {
          // Extract preview and full media URLs
          const preview =
            item.preview ||
            item.images?.fixed_width?.webp ||
            item.images?.fixed_width?.url ||
            item.media?.webp?.small ||
            item.media?.gif?.small ||
            item.url;

          const full =
            item.url ||
            item.images?.original?.url ||
            item.images?.downsized?.url ||
            item.media?.gif?.full ||
            preview;

          return {
            id: String(item.id || item.slug || Math.random()),
            title: item.title || item.slug || 'KLIPY GIF',
            previewUrl: preview || full,
            url: full || preview,
            width: item.width || 150,
            height: item.height || 150,
          };
        }).filter((item) => item.url);

        return NextResponse.json({ ok: true, provider: 'KLIPY', results });
      }
    } catch (err) {
      console.error('KLIPY API error:', err);
    }
  }

  // 2. GIPHY fallback if GIPHY key is configured
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
