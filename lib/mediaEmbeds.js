'use client';

// Universal Media & 18+ Embed Link Parser for ReelSync
export function parseMediaUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  // Direct 11-char YouTube ID
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) {
    return { type: 'youtube', videoId: s, title: 'YouTube Video', embedUrl: null, platform: 'YouTube' };
  }

  // YouTube Links (watch, shorts, live, embed, youtu.be)
  const ytMatch = s.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  if (ytMatch) {
    return { type: 'youtube', videoId: ytMatch[1], title: 'YouTube Video', embedUrl: null, platform: 'YouTube' };
  }

  // Pornhub
  const phMatch = s.match(/pornhub\.com\/(?:view_video\.php\?viewkey=|embed\/)([a-zA-Z0-9]+)/i);
  if (phMatch) {
    return { type: 'embed', embedUrl: 'https://www.pornhub.com/embed/' + phMatch[1], title: 'Pornhub Video', platform: 'Pornhub' };
  }

  // Xvideos
  const xvMatch = s.match(/xvideos\.com\/(?:video\.?|embedframe\/)([a-zA-Z0-9_-]+)/i);
  if (xvMatch) {
    const rawId = xvMatch[1];
    const numId = rawId.match(/^\d+/) ? rawId.match(/^\d+/)[0] : rawId;
    return { type: 'embed', embedUrl: 'https://www.xvideos.com/embedframe/' + numId, title: 'Xvideos Video', platform: 'Xvideos' };
  }

  // XHamster
  const xhMatch = s.match(/xhamster\.com\/(?:videos\/[^/]+-|xembed\.php\?video=)([a-zA-Z0-9]+)/i) || s.match(/xhamster\.com\/videos\/([a-zA-Z0-9_-]+)/i);
  if (xhMatch) {
    return { type: 'embed', embedUrl: 'https://xhamster.com/xembed.php?video=' + xhMatch[1], title: 'XHamster Video', platform: 'XHamster' };
  }

  // SpankBang
  const sbMatch = s.match(/spankbang\.com\/([a-zA-Z0-9]+)\/(?:video|embed)/i);
  if (sbMatch) {
    return { type: 'embed', embedUrl: 'https://spankbang.com/' + sbMatch[1] + '/embed/', title: 'SpankBang Video', platform: 'SpankBang' };
  }

  // RedTube
  const rtMatch = s.match(/(?:redtube\.com\/|embed\.redtube\.com\/\?id=)(\d+)/i);
  if (rtMatch) {
    return { type: 'embed', embedUrl: 'https://embed.redtube.com/?id=' + rtMatch[1], title: 'RedTube Video', platform: 'RedTube' };
  }

  // YouPorn
  const ypMatch = s.match(/youporn\.com\/(?:watch|embed)\/(\d+)/i);
  if (ypMatch) {
    return { type: 'embed', embedUrl: 'https://www.youporn.com/embed/' + ypMatch[1], title: 'YouPorn Video', platform: 'YouPorn' };
  }

  // Streamtape
  const stMatch = s.match(/streamtape\.com\/[ve]\/([a-zA-Z0-9]+)/i);
  if (stMatch) {
    return { type: 'embed', embedUrl: 'https://streamtape.com/e/' + stMatch[1], title: 'Streamtape Video', platform: 'Streamtape' };
  }

  // DoodStream
  const doodMatch = s.match(/dood\.[a-z]+\/[de]\/([a-zA-Z0-9]+)/i);
  if (doodMatch) {
    return { type: 'embed', embedUrl: 'https://dood.to/e/' + doodMatch[1], title: 'DoodStream Video', platform: 'DoodStream' };
  }

  // Direct video file stream (.mp4, .webm, .m3u8, .ogv, .mov)
  if (/\.(mp4|webm|ogv|mov|m3u8)(?:\?.*)?$/i.test(s)) {
    const filename = s.split('/').pop().split('?')[0] || 'Direct Stream';
    return { type: 'direct', url: s, title: decodeURIComponent(filename), platform: 'Direct MP4/HLS' };
  }

  // Generic https embed URL
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return { type: 'embed', embedUrl: s, title: u.hostname + ' Video', platform: u.hostname };
    } catch {
      return { type: 'embed', embedUrl: s, title: 'Web Video', platform: 'Web Embed' };
    }
  }

  return null;
}
