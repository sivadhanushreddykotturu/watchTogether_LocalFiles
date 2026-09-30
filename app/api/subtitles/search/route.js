// app/api/subtitles/search/route.js
import { NextResponse } from 'next/server';
import { searchSubdl } from '@/lib/subdl';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const title = searchParams.get('title') || '';
    const tmdbId = searchParams.get('tmdbId') || searchParams.get('tmdb_id') || '';
    const imdbId = searchParams.get('imdbId') || searchParams.get('imdb_id') || '';
    const mediaType = searchParams.get('mediaType') || searchParams.get('type') || 'movie';
    const season = searchParams.get('season') || searchParams.get('season_number');
    const episode = searchParams.get('episode') || searchParams.get('episode_number');
    const languages = searchParams.get('languages') || searchParams.get('lang') || 'en';

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
