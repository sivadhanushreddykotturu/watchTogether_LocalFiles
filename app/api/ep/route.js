import { NextResponse } from 'next/server';
import { resolveEporner } from '../../../lib/epornerServer';

export const dynamic = 'force-dynamic';

// GET /api/ep?id=<video id>&quality=1080  -> direct MP4 link (plus the other qualities)
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id') || '';
  const want = Number(searchParams.get('quality')) || 1080;
  try {
    const data = await resolveEporner(id, want);
    return NextResponse.json({ ok: true, ...data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const msg = String(err?.message || err);
    const bad = /Invalid/.test(msg);
    if (!bad) console.error('Eporner resolve error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: bad ? 400 : 502 });
  }
}
