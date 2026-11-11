import { NextResponse } from 'next/server';

// TorBox plan ids (see api-docs.torbox.app): 0 Free, 1 Essential, 2 Pro, 3 Standard
const PLAN_NAMES = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Standard' };

export async function GET(req) {
  const token = (req.headers.get('x-torbox-key') || '').trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: 'No API key provided' }, { status: 401 });
  }

  try {
    const res = await fetch('https://api.torbox.app/v1/api/user/me?settings=false', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success || !json?.data) {
      return NextResponse.json({ ok: false, error: json?.detail || 'TorBox rejected this API key' });
    }
    const plan = Number(json.data.plan);
    return NextResponse.json({
      ok: true,
      plan: PLAN_NAMES[plan] || `Plan ${plan}`,
      // /stream/createstream (the transcoder) is a Pro-only feature
      isPro: plan === 2,
      expiresAt: json.data.premium_expires_at || null,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not reach TorBox' });
  }
}
