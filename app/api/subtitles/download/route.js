// app/api/subtitles/download/route.js
import { NextResponse } from 'next/server';

const SUBDL_API_KEY = process.env.SUBDL_API_KEY || 'subdl_N29f3ozGhXgOz4ZG_3jPIaEhlo-do18dxT38mm3sTxU';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    let targetUrl = searchParams.get('url');

    if (!targetUrl) {
      return new NextResponse('Missing url parameter', { status: 400 });
    }

    if (targetUrl.startsWith('/')) {
      targetUrl = `https://dl.subdl.com${targetUrl}`;
    }

    // Security check: only allow dl.subdl.com or api.subdl.com
    const parsed = new URL(targetUrl);
    if (!parsed.hostname.endsWith('subdl.com')) {
      return new NextResponse('Invalid subtitle host', { status: 403 });
    }

    // Ensure api_key is present on the outgoing request
    if (!parsed.searchParams.has('api_key')) {
      parsed.searchParams.set('api_key', SUBDL_API_KEY);
    }

    const res = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) {
      return new NextResponse(`Failed to fetch subtitle from SubDL (${res.status})`, { status: res.status });
    }

    const text = await res.text();

    return new NextResponse(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error('Subtitle download proxy error:', err);
    return new NextResponse(`Subtitle download error: ${err.message}`, { status: 500 });
  }
}
