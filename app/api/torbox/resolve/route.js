import { NextResponse } from 'next/server';

const YTS_DOMAINS = ['yts.am', 'yts.pm', 'yts.do', 'yts.rs'];

async function searchYts(query, imdbId) {
  for (const domain of YTS_DOMAINS) {
    try {
      const searchTerm = imdbId || query;
      const res = await fetch(`https://${domain}/api/v2/list_movies.json?query_term=${encodeURIComponent(searchTerm)}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.data?.movies?.length > 0) {
        return json.data.movies[0];
      }
    } catch {}
  }
  return null;
}

async function searchPirateBay(query) {
  try {
    const res = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json) ? json.filter((t) => t.info_hash && t.info_hash !== '0000000000000000000000000000000000000000') : [];
  } catch {
    return [];
  }
}

export async function POST(req) {
  try {
    const { title, year, imdbId, tmdbId, mediaType, season, episode } = await req.json();
    const token = process.env.TORBOX_API_KEY;

    if (!token) {
      return NextResponse.json({ success: false, error: 'TORBOX_API_KEY not configured' }, { status: 500 });
    }

    const isTv = mediaType === 'tv' || (season !== undefined && episode !== undefined);

    // ──────────────────────────────────────────
    // TV SERIES RESOLVER
    // ──────────────────────────────────────────
    if (isTv) {
      const sNum = Number(season) || 1;
      const eNum = Number(episode) || 1;
      const sStr = String(sNum).padStart(2, '0');
      const eStr = String(eNum).padStart(2, '0');

      // Search PiratyBay for candidate packs/episodes
      const pbTorrents = await searchPirateBay(title);
      if (pbTorrents.length === 0) {
        return NextResponse.json({ success: false, cached: false, reason: 'No torrents found for series' });
      }

      const hashes = pbTorrents.slice(0, 30).map((t) => t.info_hash.toLowerCase());

      // Batch check TorBox cache
      const cacheRes = await fetch('https://api.torbox.app/v1/api/torrents/checkcached?format=list', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hashes }),
        signal: AbortSignal.timeout(5000),
      });

      if (!cacheRes.ok) {
        return NextResponse.json({ success: false, cached: false, reason: 'TorBox cache check failed' });
      }

      const cacheJson = await cacheRes.json();
      const cachedList = Array.isArray(cacheJson.data) ? cacheJson.data : [];
      if (cachedList.length === 0) {
        return NextResponse.json({ success: false, cached: false, reason: 'No cached torrent found on TorBox' });
      }

      const targetHash = cachedList[0].hash.toLowerCase();

      // Add to TorBox
      const form = new FormData();
      form.append('magnet', `magnet:?xt=urn:btih:${targetHash}`);
      form.append('add_only_if_cached', 'true');

      const addRes = await fetch('https://api.torbox.app/v1/api/torrents/createtorrent', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(6000),
      });

      if (!addRes.ok) {
        return NextResponse.json({ success: false, cached: false, reason: 'Failed to add torrent to TorBox' });
      }

      const addJson = await addRes.json();
      const torrentId = addJson.data?.torrent_id;
      if (!torrentId) {
        return NextResponse.json({ success: false, cached: false, reason: 'Torrent ID not returned by TorBox' });
      }

      // Fetch files list
      const listRes = await fetch(`https://api.torbox.app/v1/api/torrents/mylist?id=${torrentId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });

      if (!listRes.ok) {
        return NextResponse.json({ success: false, cached: false, reason: 'Failed to fetch files list' });
      }

      const listJson = await listRes.json();
      const files = listJson.data?.files || [];

      // Regex match episode file (e.g., S01E01, 1x01, or Episode 1)
      const epRegex = new RegExp(`(?:s${sStr}e${eStr}|${sNum}x${eStr}|episode\\s*0?${eNum})`, 'i');
      const epFile = files.find((f) => epRegex.test(f.name)) || files.find((f) => f.name.endsWith('.mkv') || f.name.endsWith('.mp4'));

      if (!epFile) {
        return NextResponse.json({ success: false, cached: false, reason: 'Episode file not found in torrent' });
      }

      // Generate HLS Stream
      const streamRes = await fetch(
        `https://api.torbox.app/v1/api/stream/createstream?id=${torrentId}&file_id=${epFile.id}&type=torrent&chosen_subtitle_index=null&chosen_audio_index=0&chosen_resolution_index=null`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(7000),
        }
      );

      let hlsUrl = null;
      if (streamRes.ok) {
        const streamJson = await streamRes.json();
        hlsUrl = streamJson.data?.hls_url;
      }

      if (!hlsUrl) {
        const dlRes = await fetch(
          `https://api.torbox.app/v1/api/torrents/requestdl?token=${token}&torrent_id=${torrentId}&file_id=${epFile.id}&redirect=false`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (dlRes.ok) {
          const dlJson = await dlRes.json();
          hlsUrl = dlJson.data;
        }
      }

      return NextResponse.json({
        success: true,
        cached: true,
        hlsUrl,
        title: `${title} S${sStr}:E${eStr}`,
        fileName: epFile.name,
        quality: '1080p',
      });
    }

    // ──────────────────────────────────────────
    // MOVIE RESOLVER
    // ──────────────────────────────────────────
    let resolvedImdb = imdbId;
    if (!resolvedImdb && tmdbId) {
      try {
        const tmdbApiKey = process.env.TMDB_API_KEY || 'baf435afe9fef24b14b2a137359e4124';
        const tmdbRes = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${tmdbApiKey}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (tmdbRes.ok) {
          const ids = await tmdbRes.json();
          if (ids.imdb_id) resolvedImdb = ids.imdb_id;
        }
      } catch {}
    }

    const movie = await searchYts(title, resolvedImdb);
    const torrents = movie?.torrents || [];
    if (torrents.length === 0) {
      return NextResponse.json({ success: false, cached: false, reason: 'No torrent candidates found' });
    }

    const sortedTorrents = [...torrents].sort((a, b) => {
      const qScore = (q) => (q === '1080p' ? 3 : q === '720p' ? 2 : q === '2160p' ? 1 : 0);
      return qScore(b.quality) - qScore(a.quality);
    });

    const hashes = sortedTorrents.map((t) => t.hash.toLowerCase());

    const cacheRes = await fetch('https://api.torbox.app/v1/api/torrents/checkcached?format=list', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hashes }),
      signal: AbortSignal.timeout(5000),
    });

    if (!cacheRes.ok) {
      return NextResponse.json({ success: false, cached: false, reason: 'TorBox cache check failed' });
    }

    const cacheJson = await cacheRes.json();
    const cachedList = Array.isArray(cacheJson.data) ? cacheJson.data : [];
    if (cachedList.length === 0) {
      return NextResponse.json({ success: false, cached: false, reason: 'No cached stream available on TorBox' });
    }

    const cachedHashes = new Set(cachedList.map((c) => c.hash.toLowerCase()));
    const bestTorrent = sortedTorrents.find((t) => cachedHashes.has(t.hash.toLowerCase())) || sortedTorrents[0];
    const targetHash = bestTorrent.hash.toLowerCase();

    const form = new FormData();
    form.append('magnet', `magnet:?xt=urn:btih:${targetHash}`);
    form.append('add_only_if_cached', 'true');

    const addRes = await fetch('https://api.torbox.app/v1/api/torrents/createtorrent', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(6000),
    });

    if (!addRes.ok) {
      return NextResponse.json({ success: false, cached: false, reason: 'Failed to create torrent on TorBox' });
    }

    const addJson = await addRes.json();
    const torrentId = addJson.data?.torrent_id;
    if (!torrentId) {
      return NextResponse.json({ success: false, cached: false, reason: 'Torrent ID not returned by TorBox' });
    }

    const listRes = await fetch(`https://api.torbox.app/v1/api/torrents/mylist?id=${torrentId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!listRes.ok) {
      return NextResponse.json({ success: false, cached: false, reason: 'Failed to fetch torrent files list' });
    }

    const listJson = await listRes.json();
    const files = listJson.data?.files || [];
    const videoFile = files.find((f) => f.name.endsWith('.mp4') || f.name.endsWith('.mkv')) || files[0];
    const srtFile = files.find((f) => f.name.endsWith('.srt'));

    if (!videoFile) {
      return NextResponse.json({ success: false, cached: false, reason: 'No video file found in torrent' });
    }

    const streamRes = await fetch(
      `https://api.torbox.app/v1/api/stream/createstream?id=${torrentId}&file_id=${videoFile.id}&type=torrent&chosen_subtitle_index=null&chosen_audio_index=0&chosen_resolution_index=null`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(7000),
      }
    );

    let hlsUrl = null;
    if (streamRes.ok) {
      const streamJson = await streamRes.json();
      hlsUrl = streamJson.data?.hls_url;
    }

    if (!hlsUrl) {
      const dlRes = await fetch(
        `https://api.torbox.app/v1/api/torrents/requestdl?token=${token}&torrent_id=${torrentId}&file_id=${videoFile.id}&redirect=false`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (dlRes.ok) {
        const dlJson = await dlRes.json();
        hlsUrl = dlJson.data;
      }
    }

    if (!hlsUrl) {
      return NextResponse.json({ success: false, cached: false, reason: 'Could not generate stream URL' });
    }

    let subtitleUrl = null;
    if (srtFile) {
      try {
        const srtRes = await fetch(
          `https://api.torbox.app/v1/api/torrents/requestdl?token=${token}&torrent_id=${torrentId}&file_id=${srtFile.id}&redirect=false`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (srtRes.ok) {
          const srtJson = await srtRes.json();
          subtitleUrl = srtJson.data;
        }
      } catch {}
    }

    return NextResponse.json({
      success: true,
      cached: true,
      hlsUrl,
      subtitleUrl,
      quality: bestTorrent.quality || '1080p',
      fileSize: videoFile.size,
      fileName: videoFile.name,
      title: movie.title || title,
    });
  } catch (err) {
    console.error('TorBox resolve error:', err);
    return NextResponse.json({ success: false, cached: false, error: err.message }, { status: 500 });
  }
}
