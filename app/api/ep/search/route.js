import { NextResponse } from 'next/server';
import { searchEporner } from '../../../../lib/epornerServer';

export const dynamic = 'force-dynamic';

// GET /api/ep/search?q=&page=1&order=top-weekly  (empty q = browse)
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  try {
    const data = await searchEporner({
      q: searchParams.get('q') || '',
      page: searchParams.get('page') || 1,
      order: searchParams.get('order') || 'top-weekly',
    });
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    console.error('Eporner search error:', err?.message || err);
    return NextResponse.json({ ok: false, error: 'Search request failed', results: [], hasMore: false }, { status: 502 });
  }
}
