import { NextResponse } from 'next/server';
import crypto from 'crypto';

const KISSKH_KEY = Buffer.from('8056483646328763', 'utf8');
const KISSKH_IV = Buffer.from('6852612370185273', 'utf8');

function decryptKisskhLine(cipherText) {
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', KISSKH_KEY, KISSKH_IV);
    let decrypted = decipher.update(cipherText.trim(), 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return cipherText;
  }
}

function processToWebVtt(rawText) {
  const lines = rawText.split(/\r?\n/);
  const processedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    // Preserve sequence numbers
    if (/^\d+$/.test(trimmed)) return trimmed;
    // Format timestamps from SRT (comma) to WebVTT (dot)
    if (trimmed.includes('-->')) {
      return trimmed.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }
    // Check if line looks like Base64 ciphertext (KissKH encrypted cue)
    if (/^[A-Za-z0-9+/=]{16,}$/.test(trimmed)) {
      return decryptKisskhLine(trimmed);
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

    if (!targetUrl) {
      return new NextResponse('Missing url parameter', { status: 400 });
    }

    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return new NextResponse('Invalid URL protocol', { status: 400 });
    }

    const res = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(9000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Referer': 'https://kisskh.is/',
        'Origin': 'https://kisskh.is',
      },
    });

    if (!res.ok) {
      return new NextResponse(`Failed to fetch subtitle (${res.status})`, { status: res.status });
    }

    const rawText = await res.text();
    const vttContent = processToWebVtt(rawText);

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
