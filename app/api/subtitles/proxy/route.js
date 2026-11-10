import { NextResponse } from 'next/server';
import crypto from 'crypto';

const KISSKH_PRIMARY_KEY = Buffer.from('AmSmZVcH93UQUezi', 'utf8');
const KISSKH_PRIMARY_IV = Buffer.from('ReBKWW8cqdjPEnF6', 'utf8');

const KISSKH_LEGACY_KEY = Buffer.from('8056483646328763', 'utf8');
const KISSKH_LEGACY_IV = Buffer.from('6852612370185273', 'utf8');

function decryptKisskhLine(cipherText) {
  const trimmed = (cipherText || '').trim();
  if (!trimmed) return cipherText;

  // Try current Primary Key & IV
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', KISSKH_PRIMARY_KEY, KISSKH_PRIMARY_IV);
    let dec = decipher.update(trimmed, 'base64', 'utf8');
    dec += decipher.final('utf8');
    if (dec && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(dec)) {
      return dec;
    }
  } catch {}

  // Fallback to Legacy Key & IV
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', KISSKH_LEGACY_KEY, KISSKH_LEGACY_IV);
    let dec = decipher.update(trimmed, 'base64', 'utf8');
    dec += decipher.final('utf8');
    if (dec && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(dec)) {
      return dec;
    }
  } catch {}

  return cipherText;
}

function processToWebVtt(rawText, isKisskh = false) {
  const lines = rawText.split(/\r?\n/);
  const processedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    // Preserve sequence numbers
    if (/^\d+$/.test(trimmed)) return trimmed;
    // Format timestamps from SRT (comma) to WebVTT (dot)
    if (trimmed.includes('-->')) {
      return trimmed.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, (match, p1, p2) => `${p1}.${p2}`);
    }
    // Attempt KissKH decryption if provider is KissKH or if line looks like base64 ciphertext
    if (isKisskh || /^[A-Za-z0-9+/=]{16,}$/.test(trimmed)) {
      const dec = decryptKisskhLine(trimmed);
      if (dec !== trimmed) return dec;
    }
    return line;
  });

  let vtt = processedLines.join('\n').trim();
  if (!vtt.startsWith('WEBVTT')) {
    vtt = 'WEBVTT\n\n' + vtt;
  }
  return vtt;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const targetUrl = searchParams.get('url');
    const provider = (searchParams.get('provider') || '').toLowerCase();

    if (!targetUrl) {
      return new NextResponse('Missing url parameter', { status: 400 });
    }

    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return new NextResponse('Invalid URL protocol', { status: 400 });
    }

    const isKisskh = provider === 'kisskh' || parsed.hostname.includes('kisskh') || parsed.hostname.includes('cdnvideo');
    const isVidlink = provider === 'vidlink' || parsed.hostname.includes('vidlink') || parsed.hostname.includes('hakunaymatata');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };

    if (isKisskh) {
      headers['Referer'] = 'https://kisskh.is/';
      headers['Origin'] = 'https://kisskh.is';
    } else if (isVidlink) {
      headers['Referer'] = 'https://vidlink.pro/';
    }

    let res = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(9000),
      headers,
    }).catch(() => null);

    if (!res || !res.ok) {
      // Retry without custom referer/origin in case CDN rejects them
      res = await fetch(parsed.toString(), {
        signal: AbortSignal.timeout(9000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': '*/*',
        },
      }).catch(() => null);
    }

    if (!res || !res.ok) {
      const status = res ? res.status : 502;
      return new NextResponse(`Failed to fetch subtitle (${status})`, { status });
    }

    const rawText = await res.text();
    const vttContent = processToWebVtt(rawText, isKisskh);

    return new NextResponse(vttContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error('[Subtitle Proxy Error]:', err);
    return new NextResponse(`Subtitle proxy error: ${err.message}`, { status: 500 });
  }
}
