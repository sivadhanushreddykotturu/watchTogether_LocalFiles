'use client';

// YouTube & PH Embed Link Parser for ReelSync
export function parseMediaUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  // 1. Raw iframe code pasted e.g. <iframe src="https://www.pornhub.org/embed/69f8cafb9b1b7" ...
  const iframeMatch = s.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  const target = iframeMatch ? iframeMatch[1].trim() : s;

  // 2. Direct 11-char YouTube ID
  if (/^[A-Za-z0-9_-]{11}$/.test(target)) {
    return { type: 'youtube', videoId: target, title: 'YouTube Video', embedUrl: null, platform: 'YouTube' };
  }

  // 3. YouTube Links (watch, shorts, live, embed, youtu.be)
  const ytMatch = target.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  if (ytMatch) {
    return { type: 'youtube', videoId: ytMatch[1], title: 'YouTube Video', embedUrl: null, platform: 'YouTube' };
  }

  // 4. PH Links (pornhub.com, pornhub.org, pornhub.net with any country subdomain e.g. de., fr., it., www.)
  const phMatch = target.match(/(?:[a-zA-Z0-9-]+\.)?pornhub\.(?:com|org|net)\/(?:view_video\.php\?viewkey=|embed\/)([a-zA-Z0-9]+)/i);
  if (phMatch) {
    const viewkey = phMatch[1];
    const domainMatch = target.match(/pornhub\.(?:com|org|net)/i);
    const domain = domainMatch ? domainMatch[0].toLowerCase() : 'pornhub.org';
    return {
      type: 'ph',
      viewkey,
      embedUrl: `https://www.${domain}/embed/${viewkey}`,
      title: `PH Video (${viewkey})`,
      platform: 'PH',
    };
  }

  // 5. Direct video stream files (.mp4, .webm, .m3u8, .ogv, .mov)
  if (/\.(m3u8)(?:\?.*)?$/i.test(target)) {
    const filename = target.split('/').pop().split('?')[0] || 'HLS Stream';
    return { type: 'hls', url: target, title: decodeURIComponent(filename), platform: 'HLS Stream' };
  }
  if (/\.(mp4|webm|ogv|mov)(?:\?.*)?$/i.test(target)) {
    const filename = target.split('/').pop().split('?')[0] || 'Direct Stream';
    return { type: 'direct', url: target, title: decodeURIComponent(filename), platform: 'Direct Stream' };
  }

  return null;
}

// Asynchronously resolve direct playable stream (e.g. extracting PH HLS streams for full sync)
export async function resolveMediaUrl(input) {
  const parsed = parseMediaUrl(input);
  if (!parsed) return null;

  if (parsed.platform === 'PH' && parsed.viewkey) {
    try {
      const res = await fetch(`/api/ph?viewkey=${encodeURIComponent(parsed.viewkey)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.hlsUrl) {
          return {
            type: 'hls',
            url: data.hlsUrl,
            title: data.title || parsed.title,
            duration: data.duration,
            viewkey: parsed.viewkey,
            platform: 'PH',
          };
        }
      }
    } catch (e) {
      console.warn('Failed to extract native PH HLS stream, using embed fallback:', e);
    }
  }

  return parsed;
}
