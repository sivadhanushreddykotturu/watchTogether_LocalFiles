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
    let rawSeason = searchParams.get('season') || searchParams.get('season_number');
    let rawEpisode = searchParams.get('episode') || searchParams.get('episode_number');

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

    // Auto-detect Season and Episode patterns from the title string (e.g. "East of Eden S01E03" or "Show 1x03")
    let detectedType = mediaType;
    if (title) {
      const seMatch = title.match(/(?:s|season\s*)(\d{1,2})[.\s_-]*(?:e|ep|episode\s*)(\d{1,3})/i) ||
                      title.match(/(\d{1,2})x(\d{1,3})/i);
      if (seMatch) {
        if (!rawSeason) rawSeason = seMatch[1];
        if (!rawEpisode) rawEpisode = seMatch[2];
        detectedType = 'tv';
        // Clean out S01E03 from the film search title for better SubDL database matching
        title = title.replace(/(?:s|season\s*)\d{1,2}[.\s_-]*(?:e|ep|episode\s*)\d{1,3}/i, '')
                     .replace(/\d{1,2}x\d{1,3}/i, '')
                     .replace(/[._-]/g, ' ')
                     .trim();
      }
    }

    const season = rawSeason !== null && rawSeason !== undefined && rawSeason !== '' ? Number(rawSeason) : undefined;
    const episode = rawEpisode !== null && rawEpisode !== undefined && rawEpisode !== '' ? Number(rawEpisode) : undefined;

    if (!title && !tmdbId && !imdbId) {
      return NextResponse.json({ success: false, error: 'Title or TMDB/IMDB ID required' }, { status: 400 });
    }

    const subtitles = await searchSubdl({
      title,
      tmdbId,
      imdbId,
      mediaType: detectedType,
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
