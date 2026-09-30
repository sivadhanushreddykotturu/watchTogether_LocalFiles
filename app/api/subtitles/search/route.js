// app/api/subtitles/search/route.js
import { NextResponse } from 'next/server';
import { searchSubdl, SUBDL_LANG_MAP, normalizeSubdlLang } from '@/lib/subdl';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    let title = searchParams.get('title') || '';
    const tmdbId = searchParams.get('tmdbId') || searchParams.get('tmdb_id') || '';
    const imdbId = searchParams.get('imdbId') || searchParams.get('imdb_id') || '';
    const mediaType = searchParams.get('mediaType') || searchParams.get('type') || 'movie';
    const rawSeason = searchParams.get('season') || searchParams.get('season_number');
    const rawEpisode = searchParams.get('episode') || searchParams.get('episode_number');
    const season = rawSeason !== null && rawSeason !== '' ? Number(rawSeason) : undefined;
    const episode = rawEpisode !== null && rawEpisode !== '' ? Number(rawEpisode) : undefined;

    let languages = searchParams.get('languages') || searchParams.get('lang') || searchParams.get('q') || 'en';

    // If the user typed a query that is actually a movie/show title (not a known language),
    // treat it as the search title instead of breaking language search!
    const cleanLangQuery = String(languages).trim().toLowerCase();
    const isKnownLanguage = cleanLangQuery in SUBDL_LANG_MAP || /^[a-z]{2}(?:-[a-z]{2})?$/i.test(cleanLangQuery);

    if (!isKnownLanguage && cleanLangQuery.length > 2) {
      // The user searched for a film/show name (e.g. "Iron Man", "Attack on Titan")
      title = languages;
      languages = 'en'; // default back to english subtitles for the queried title
    }

    if (!title && !tmdbId && !imdbId) {
      return NextResponse.json({ success: false, error: 'Title or TMDB/IMDB ID required' }, { status: 400 });
    }

    const subtitles = await searchSubdl({
      title,
      tmdbId,
      imdbId,
      mediaType,
      season,
      episode,
      languages,
    });

    return NextResponse.json({
      success: true,
      subtitles,
      count: subtitles.length,
      defaultSubtitleUrl: subtitles.length > 0 ? subtitles[0].url : null,
    });
  } catch (err) {
    console.error('Subtitle search API error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
