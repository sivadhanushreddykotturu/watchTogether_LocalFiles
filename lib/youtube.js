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
