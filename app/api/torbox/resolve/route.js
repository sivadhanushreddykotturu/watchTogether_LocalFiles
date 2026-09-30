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

export async function POST(req) {
  try {
    const { title, year, imdbId, tmdbId } = await req.json();
    const token = process.env.TORBOX_API_KEY;

    if (!token) {
      return NextResponse.json({ success: false, error: 'TORBOX_API_KEY not configured' }, { status: 500 });
    }

    if (!title && !imdbId && !tmdbId) {
      return NextResponse.json({ success: false, error: 'Missing title or id' }, { status: 400 });
    }

    // 1. Resolve IMDb ID from TMDB if not provided
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

    // 2. Search YTS for candidate torrents
    const movie = await searchYts(title, resolvedImdb);
    const torrents = movie?.torrents || [];
    if (torrents.length === 0) {
      return NextResponse.json({ success: false, cached: false, reason: 'No torrent candidates found' });
    }

    // Sort: prefer 1080p, then 720p, then 2160p
    const sortedTorrents = [...torrents].sort((a, b) => {
      const qScore = (q) => (q === '1080p' ? 3 : q === '720p' ? 2 : q === '2160p' ? 1 : 0);
      return qScore(b.quality) - qScore(a.quality);
    });

    const hashes = sortedTorrents.map((t) => t.hash.toLowerCase());

    // 3. Batch check TorBox cache
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

    // Find best cached torrent matching our quality priority
    const cachedHashes = new Set(cachedList.map((c) => c.hash.toLowerCase()));
    const bestTorrent = sortedTorrents.find((t) => cachedHashes.has(t.hash.toLowerCase())) || sortedTorrents[0];
    const targetHash = bestTorrent.hash.toLowerCase();

    // 4. Add cached torrent to TorBox
    const form = new FormData();
    form.append('magnet', `magnet:?xt=urn:btih:${targetHash}`);
    form.append('add_only_if_cached', 'true');

    const addRes = await fetch('https://api.torbox.app/v1/api/torrents/createtorrent', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
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

    // 5. Query torrent file list
    const listRes = await fetch(`https://api.torbox.app/v1/api/torrents/mylist?id=${torrentId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
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

    // 6. Request HLS Stream via createstream
    const streamRes = await fetch(
      `https://api.torbox.app/v1/api/stream/createstream?id=${torrentId}&file_id=${videoFile.id}&type=torrent&chosen_subtitle_index=null&chosen_audio_index=0&chosen_resolution_index=null`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(7000),
      }
    );

    let hlsUrl = null;
    if (streamRes.ok) {
      const streamJson = await streamRes.json();
      hlsUrl = streamJson.data?.hls_url;
    }

    // Fallback to direct download link if createstream didn't return hls_url
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

    // 7. Get subtitle link if available
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
