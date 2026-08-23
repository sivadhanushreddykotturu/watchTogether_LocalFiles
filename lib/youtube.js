'use client';

// YouTube IFrame Player API — loaded once, shared by every room visit.
let apiPromise;

export function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onerror = () => { apiPromise = null; reject(new Error('iframe_api blocked')); };
      document.head.appendChild(tag);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      // a blocked script can also fail silently — don't wait forever
      setTimeout(() => {
        if (!window.YT || !window.YT.Player) { apiPromise = null; reject(new Error('iframe_api timed out')); }
      }, 12000);
    });
  }
  return apiPromise;
}

// Accepts watch/share/shorts/live/embed URLs or a bare 11-char video id.
export function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

export async function fetchYouTubeInfo(videoId) {
  if (!videoId) return { title: 'YouTube Video', thumbnail: '' };
  try {
    const res = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.title) {
        return {
          title: data.title,
          author: data.author_name || '',
          thumbnail: data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        };
      }
    }
  } catch {
    // fallback if noembed is unreachable
  }
  return {
    title: `YouTube Video (${videoId})`,
    author: '',
    thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  };
}

export async function searchYouTube(query, signal) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}`, { signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    if (err.name === 'AbortError') return [];
    console.error('searchYouTube error:', err);
    return [];
  }
}

