'use client';

// YouTube, Pornhub & Universal Direct CDN Stream Parser for ReelSync
export function parseMediaUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;

  // Auto-extract pure URL if text contains DevTools header info or surrounding text
  const urlMatch = s.match(/https?:\/\/[^\s"'>]+/i);
  const target = urlMatch ? urlMatch[0].trim() : s;

  // 1. Raw iframe code pasted e.g. <iframe src="https://www.pornhub.org/embed/69f8cafb9b1b7" ...
  const iframeMatch = s.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  const cleanTarget = iframeMatch ? iframeMatch[1].trim() : target;

  // 2. Direct 11-char YouTube ID
  if (/^[A-Za-z0-9_-]{11}$/.test(cleanTarget)) {
    return { type: 'youtube', videoId: cleanTarget, title: 'YouTube Video', embedUrl: null, platform: 'YouTube' };
  }

  // 3. YouTube Links (watch, shorts, live, embed, youtu.be)
  const ytMatch = cleanTarget.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  if (ytMatch) {
    return { type: 'youtube', videoId: ytMatch[1], title: 'YouTube Video', embedUrl: null, platform: 'YouTube' };
  }

  // 4. Spotify Links (track, album, playlist, episode, podcast)
  const spotifyMatch = cleanTarget.match(/(?:open\.spotify\.com\/(?:track|album|playlist|episode)\/|spotify:(?:track|album|playlist|episode):)([a-zA-Z0-9]+)/i);
  if (spotifyMatch) {
    const spotifyId = spotifyMatch[1];
    return {
      type: 'spotify',
      spotifyId,
      url: cleanTarget,
      title: 'Spotify Track',
      platform: 'Spotify',
    };
  }

  // 5. VidFast, Vidlove & TMDB Links
  const vidfastTvMatch = cleanTarget.match(/(?:vidfast\.(?:pro|in|io|me|net|pm|xyz|vc|bz))\/tv\/([a-zA-Z0-9_-]+)(?:\/(\d+))?(?:\/(\d+))?/i);
  if (vidfastTvMatch) {
    const tmdbId = vidfastTvMatch[1];
    const season = Number(vidfastTvMatch[2] || 1);
    const episode = Number(vidfastTvMatch[3] || 1);
    return {
      type: 'embed',
      embedUrl: cleanTarget,
      title: `Series (TMDB ${tmdbId}) S${season}:E${episode}`,
      platform: 'VidFast',
      mediaType: 'tv',
      tmdbId,
      season,
      episode,
    };
  }

  const vidfastMovieMatch = cleanTarget.match(/(?:vidfast\.(?:pro|in|io|me|net|pm|xyz|vc|bz))\/movie\/([a-zA-Z0-9_-]+)/i);
  if (vidfastMovieMatch) {
    const tmdbId = vidfastMovieMatch[1];
    return {
      type: 'embed',
      embedUrl: cleanTarget,
      title: `Movie (TMDB ${tmdbId})`,
      platform: 'VidFast',
      mediaType: 'movie',
      tmdbId,
    };
  }

  const vidloveTvMatch = cleanTarget.match(/player\.vidlove\.cc\/embed\/tv\/(\d+)(?:\/(\d+))?(?:\/(\d+))?/i);
  if (vidloveTvMatch) {
    const tmdbId = vidloveTvMatch[1];
    const season = Number(vidloveTvMatch[2] || 1);
    const episode = Number(vidloveTvMatch[3] || 1);
    return {
      type: 'embed',
      embedUrl: cleanTarget,
      title: `Series (TMDB ${tmdbId}) S${season}:E${episode}`,
      platform: 'VidFast',
      mediaType: 'tv',
      tmdbId,
      season,
      episode,
    };
  }

  const vidloveMovieMatch = cleanTarget.match(/player\.vidlove\.cc\/embed\/movie\/(\d+)/i);
  if (vidloveMovieMatch) {
    const tmdbId = vidloveMovieMatch[1];
    return {
      type: 'embed',
      embedUrl: cleanTarget,
      title: `Movie (TMDB ${tmdbId})`,
      platform: 'VidFast',
      mediaType: 'movie',
      tmdbId,
    };
  }

  const tmdbTvMatch = cleanTarget.match(/themoviedb\.org\/tv\/(\d+)(?:[^\s/]*)(?:\/season\/(\d+))?(?:\/episode\/(\d+))?/i);
  if (tmdbTvMatch) {
    const tmdbId = tmdbTvMatch[1];
    const season = Number(tmdbTvMatch[2] || 1);
    const episode = Number(tmdbTvMatch[3] || 1);
    return {
      type: 'embed',
      embedUrl: `https://vidfast.vc/tv/${tmdbId}/${season}/${episode}?autoPlay=true&theme=6366f1&nextButton=true&autoNext=true`,
      title: `Series (TMDB ${tmdbId}) S${season}:E${episode}`,
      platform: 'VidFast',
      mediaType: 'tv',
      tmdbId,
      season,
      episode,
    };
  }

  const tmdbMovieMatch = cleanTarget.match(/themoviedb\.org\/movie\/(\d+)/i);
  if (tmdbMovieMatch) {
    const tmdbId = tmdbMovieMatch[1];
    return {
      type: 'embed',
      embedUrl: `https://vidfast.vc/movie/${tmdbId}?autoPlay=true&theme=6366f1`,
      title: `Movie (TMDB ${tmdbId})`,
      platform: 'VidFast',
      mediaType: 'movie',
      tmdbId,
    };
  }

  // 6. PH Links (pornhub.com, pornhub.org, pornhub.net with any country subdomain e.g. de., fr., it., www.)
  const phMatch = cleanTarget.match(/(?:[a-zA-Z0-9-]+\.)?pornhub\.(?:com|org|net)\/(?:view_video\.php\?viewkey=|embed\/)([a-zA-Z0-9]+)/i);
  if (phMatch) {
    const viewkey = phMatch[1];
    const domainMatch = cleanTarget.match(/pornhub\.(?:com|org|net)/i);
    const domain = domainMatch ? domainMatch[0].toLowerCase() : 'pornhub.org';
    return {
      type: 'ph',
      viewkey,
      embedUrl: `https://www.${domain}/embed/${viewkey}`,
      title: `PH Video (${viewkey})`,
      platform: 'PH',
    };
  }

  // 6. TorBox & Debrid Direct CDN Streams (tb-cdn.pw, torbox.app, etc.)
  if (cleanTarget.includes('tb-cdn.pw') || cleanTarget.includes('torbox.app')) {
    const isHls = cleanTarget.includes('.m3u8') || cleanTarget.includes('/stream/');
    return {
      type: isHls ? 'hls' : 'direct',
      url: cleanTarget,
      rawUrl: cleanTarget,
      title: 'TorBox Stream',
      platform: 'TorBox',
    };
  }

  // 7. Direct video stream files & standard CDNs (.m3u8, .mp4, .webm, .ogv, .mov)
  if (/\.(m3u8)(?:\?.*)?$/i.test(cleanTarget) || cleanTarget.includes('.m3u8') || cleanTarget.includes('/hls/')) {
    const filename = cleanTarget.split('/').pop().split('?')[0] || 'HLS Stream';
    return {
      type: 'hls',
      url: cleanTarget,
      rawUrl: cleanTarget,
      title: decodeURIComponent(filename),
      platform: 'HLS Stream',
    };
  }
  if (
    /\.(mp4|webm|ogv|mov)(?:\?.*)?$/i.test(cleanTarget) ||
    /(?:\?|&)(?:file|name|ext|filename)=[^&#]*\.(mp4|webm|ogv|mov)/i.test(cleanTarget)
  ) {
    const filename = cleanTarget.split('/').pop().split('?')[0] || 'Direct Stream';
    return { type: 'direct', url: cleanTarget, title: decodeURIComponent(filename), platform: 'Direct Stream' };
  }

  return null;
}

// Asynchronously resolve direct playable stream (e.g. extracting PH HLS streams for full sync)
export async function resolveMediaUrl(input) {
  const parsed = parseMediaUrl(input);
  if (!parsed) return null;

  if ((parsed.platform === 'VidFast' || parsed.platform === 'Vidlove') && parsed.tmdbId) {
    try {
      if (parsed.mediaType === 'tv') {
        const res = await fetch(`/api/tmdb?action=tv&id=${encodeURIComponent(parsed.tmdbId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.ok && data.tv) {
            const showTitle = data.tv.name || parsed.title;
            return {
              ...parsed,
              title: `${showTitle} · S${parsed.season || 1}:E${parsed.episode || 1}`,
              showTitle,
              poster: data.tv.poster || null,
              backdrop: data.tv.backdrop || null,
            };
          }
        }
      } else {
        const res = await fetch(`/api/tmdb?action=movie&id=${encodeURIComponent(parsed.tmdbId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.ok && data.movie) {
            return {
              ...parsed,
              title: data.movie.title || parsed.title,
              poster: data.movie.poster || null,
              backdrop: data.movie.backdrop || null,
            };
          }
        }
      }
    } catch (e) {
      console.warn('Failed to resolve TMDB metadata:', e);
    }
    return parsed;
  }

  if (parsed.platform === 'TorBox') {
    try {
      const head = await fetch(parsed.url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      const cd = head.headers.get('content-disposition');
      if (cd) {
        const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
        if (fnMatch && fnMatch[1]) {
          const title = decodeURIComponent(fnMatch[1].replace(/["']/g, '').trim()).replace(/\.(mp4|mkv|webm|avi|mov)$/i, '').replace(/[._]/g, ' ');
          return { ...parsed, title };
        }
      }
    } catch {}
    return parsed;
  }

  if (parsed.platform === 'Spotify') {
    try {
      const res = await fetch(`/api/spotify/resolve?url=${encodeURIComponent(parsed.url || input)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          return {
            type: data.type || 'youtube',
            videoId: data.videoId,
            title: data.title,
            author: data.author,
            thumbnail: data.thumbnail,
            duration: data.duration,
            platform: 'Spotify',
            spotifyId: data.spotifyId,
            url: parsed.url,
          };
        }
      }
    } catch (e) {
      console.warn('Failed to resolve Spotify track audio:', e);
    }
  }

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

export async function searchPornhub(query, signal) {
  const q = String(query || '').trim();
  if (!q) return [];
  const res = await fetch(`/api/ph/search?q=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw new Error(`Pornhub search returned ${res.status}`);
  const data = await res.json();
  return data.results || [];
}
