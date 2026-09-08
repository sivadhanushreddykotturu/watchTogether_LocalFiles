import https from 'https';
import { NextResponse } from 'next/server';

function tmdbFetch(endpoint, params = {}) {
  const apiKey = process.env.TMDB_API_KEY || 'baf435afe9fef24b14b2a137359e4124';
  const accessToken = process.env.TMDB_ACCESS_TOKEN;

  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      searchParams.set(k, String(v));
    }
  }

  if (apiKey) {
    searchParams.set('api_key', apiKey);
  }

  const queryString = searchParams.toString();
  const url = `https://api.themoviedb.org/3${endpoint}${queryString ? '?' + queryString : ''}`;

  return new Promise((resolve, reject) => {
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'ReelSync/1.0',
    };
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (err) {
          reject(new Error(`Failed to parse TMDB response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy(new Error('TMDB request timed out'));
    });
  });
}

function formatMediaItem(item, explicitType = null) {
  const mediaType = explicitType || item.media_type || (item.first_air_date !== undefined ? 'tv' : 'movie');
  if (mediaType !== 'movie' && mediaType !== 'tv') return null;

  const isAnime =
    item.original_language === 'ja' &&
    ((item.genre_ids && item.genre_ids.includes(16)) || (item.genres && item.genres.some((g) => g.id === 16)));
  const isKdrama = item.original_language === 'ko';

  let subType = mediaType;
  if (isAnime) subType = 'anime';
  else if (isKdrama) subType = 'kdrama';

  const dateStr = item.release_date || item.first_air_date || '';
  const year = dateStr ? dateStr.slice(0, 4) : '';

  return {
    id: item.id,
    tmdbId: item.id,
    mediaType,
    subType,
    title: item.title || item.name || item.original_title || item.original_name || 'Untitled',
    originalTitle: item.original_title || item.original_name || '',
    overview: item.overview || '',
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
    backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : '',
    releaseDate: dateStr,
    year,
    rating: item.vote_average ? Number(item.vote_average).toFixed(1) : '',
    voteCount: item.vote_count || 0,
    popularity: item.popularity || 0,
    platform: 'TMDB',
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'search';
  const q = (searchParams.get('q') || '').trim();
  const type = searchParams.get('type') || 'all'; // all | movie | tv | anime | kdrama
  const id = searchParams.get('id');
  const season = searchParams.get('season') || '1';

  try {
    // 1. Trending / Popular discovery (when no search query or exploring)
    if (action === 'trending') {
      let endpoint = '/trending/all/week';
      let params = { include_adult: 'false' };

      if (type === 'movie') {
        endpoint = '/trending/movie/week';
      } else if (type === 'tv') {
        endpoint = '/trending/tv/week';
      } else if (type === 'anime') {
        endpoint = '/discover/tv';
        params = {
          with_genres: '16',
          with_original_language: 'ja',
          sort_by: 'popularity.desc',
          include_adult: 'false',
        };
      } else if (type === 'kdrama') {
        endpoint = '/discover/tv';
        params = {
          with_original_language: 'ko',
          sort_by: 'popularity.desc',
          include_adult: 'false',
        };
      }

      const res = await tmdbFetch(endpoint, params);
      const results = (res.data.results || [])
        .map((item) => formatMediaItem(item, type === 'movie' ? 'movie' : type === 'tv' || type === 'anime' || type === 'kdrama' ? 'tv' : null))
        .filter(Boolean);

      return NextResponse.json({ ok: true, results });
    }

    // 2. Search query
    if (action === 'search') {
      if (!q) {
        return NextResponse.json({ ok: true, results: [] });
      }

      let endpoint = '/search/multi';
      let params = { query: q, include_adult: 'false' };
      let explicitType = null;

      if (type === 'movie') {
        endpoint = '/search/movie';
        explicitType = 'movie';
      } else if (type === 'tv' || type === 'anime' || type === 'kdrama') {
        endpoint = '/search/tv';
        explicitType = 'tv';
      }

      const res = await tmdbFetch(endpoint, params);
      let results = (res.data.results || [])
        .map((item) => formatMediaItem(item, explicitType))
        .filter(Boolean);

      if (type === 'anime') {
        results = results.sort((a, b) => (b.subType === 'anime' ? 1 : 0) - (a.subType === 'anime' ? 1 : 0));
      } else if (type === 'kdrama') {
        results = results.sort((a, b) => (b.subType === 'kdrama' ? 1 : 0) - (a.subType === 'kdrama' ? 1 : 0));
      }

      return NextResponse.json({ ok: true, results });
    }

    // 3. TV Show Details & Seasons
    if (action === 'tv') {
      if (!id) return NextResponse.json({ ok: false, error: 'Missing TV ID' }, { status: 400 });

      const res = await tmdbFetch(`/tv/${id}`, { append_to_response: 'external_ids' });
      const d = res.data;
      if (!d || d.success === false) {
        return NextResponse.json({ ok: false, error: d?.status_message || 'TV show not found' }, { status: 404 });
      }

      const seasons = (d.seasons || []).map((s) => ({
        id: s.id,
        seasonNumber: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        overview: s.overview,
        airDate: s.air_date,
        poster: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : '',
      }));

      const details = {
        id: d.id,
        tmdbId: d.id,
        name: d.name,
        originalName: d.original_name,
        overview: d.overview,
        poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : '',
        backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
        firstAirDate: d.first_air_date,
        year: d.first_air_date ? d.first_air_date.slice(0, 4) : '',
        numberOfSeasons: d.number_of_seasons,
        numberOfEpisodes: d.number_of_episodes,
        genres: (d.genres || []).map((g) => g.name),
        rating: d.vote_average ? Number(d.vote_average).toFixed(1) : '',
        status: d.status,
        seasons,
      };

      return NextResponse.json({ ok: true, tv: details });
    }

    // 4. TV Season Episodes
    if (action === 'season') {
      if (!id) return NextResponse.json({ ok: false, error: 'Missing TV ID' }, { status: 400 });

      const res = await tmdbFetch(`/tv/${id}/season/${season}`);
      const d = res.data;
      if (!d || d.success === false) {
        return NextResponse.json({ ok: false, error: d?.status_message || 'Season not found' }, { status: 404 });
      }

      const episodes = (d.episodes || []).map((ep) => ({
        id: ep.id,
        episodeNumber: ep.episode_number,
        seasonNumber: ep.season_number,
        name: ep.name || `Episode ${ep.episode_number}`,
        overview: ep.overview,
        still: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : '',
        airDate: ep.air_date,
        runtime: ep.runtime ? `${ep.runtime} min` : '',
        rating: ep.vote_average ? Number(ep.vote_average).toFixed(1) : '',
      }));

      return NextResponse.json({
        ok: true,
        seasonNumber: Number(season),
        name: d.name,
        overview: d.overview,
        poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : '',
        episodes,
      });
    }

    // 5. Movie Details
    if (action === 'movie') {
      if (!id) return NextResponse.json({ ok: false, error: 'Missing Movie ID' }, { status: 400 });

      const res = await tmdbFetch(`/movie/${id}`);
      const d = res.data;
      if (!d || d.success === false) {
        return NextResponse.json({ ok: false, error: d?.status_message || 'Movie not found' }, { status: 404 });
      }

      const movie = {
        id: d.id,
        tmdbId: d.id,
        title: d.title,
        originalTitle: d.original_title,
        overview: d.overview,
        poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : '',
        backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
        releaseDate: d.release_date,
        year: d.release_date ? d.release_date.slice(0, 4) : '',
        runtime: d.runtime ? `${d.runtime} min` : '',
        rating: d.vote_average ? Number(d.vote_average).toFixed(1) : '',
        genres: (d.genres || []).map((g) => g.name),
        tagline: d.tagline,
      };

      return NextResponse.json({ ok: true, movie });
    }

    // 6. Sources & Subtitles from Vidlove scraper
    if (action === 'sources') {
      if (!id) return NextResponse.json({ ok: false, error: 'Missing ID' }, { status: 400 });

      const isTv = type === 'tv';
      const endpoint = isTv
        ? `https://api.vidlove.cc/tv?id=${encodeURIComponent(id)}&season=${encodeURIComponent(season || '1')}&episode=${encodeURIComponent(searchParams.get('episode') || '1')}&mode=json`
        : `https://api.vidlove.cc/movie?id=${encodeURIComponent(id)}&mode=json`;

      try {
        const scrapeRes = await fetch(endpoint, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json',
          },
          cache: 'no-store',
        });

        if (!scrapeRes.ok) {
          return NextResponse.json({ ok: true, subtitles: [], hasServers: false });
        }

        const data = await scrapeRes.json();
        const rawSubs = Array.isArray(data?.subtitles) ? data.subtitles : [];

        // Clean & sort subtitles (English first, followed by alphabetical)
        const formattedSubs = rawSubs
          .filter((s) => s && s.file && s.label)
          .map((s, idx) => ({
            id: `scraper-${idx}-${s.label.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
            label: s.label,
            url: s.file,
            type: s.type || 'vtt',
            language: s.label.toLowerCase().includes('english') ? 'en' : 'sub',
          }))
          .sort((a, b) => {
            const aEn = a.label.toLowerCase().includes('english');
            const bEn = b.label.toLowerCase().includes('english');
            if (aEn && !bEn) return -1;
            if (!aEn && bEn) return 1;
            return a.label.localeCompare(b.label);
          });

        return NextResponse.json({
          ok: true,
          subtitles: formattedSubs,
          hasServers: Boolean(data?.source?.url || data?.source?.manifest),
          source: data?.source || null,
        });
      } catch (scrapeErr) {
        console.warn('Vidlove scraper error:', scrapeErr);
        return NextResponse.json({ ok: true, subtitles: [], hasServers: false });
      }
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    console.error('TMDB API Route Error:', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
