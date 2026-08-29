import { NextResponse } from 'next/server';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getSpotifyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (clientId && clientSecret) {
    try {
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      if (res.ok) {
        const data = await res.json();
        cachedToken = data.access_token;
        tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
        return cachedToken;
      }
    } catch (e) {
      console.warn('Spotify Client Credentials failed:', e);
    }
  }

  // Fallback to Spotify web player token
  try {
    const res = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.accessToken) {
        cachedToken = data.accessToken;
        tokenExpiresAt = (data.accessTokenExpirationTimestampMs || Date.now() + 3600 * 1000) - 60000;
        return cachedToken;
      }
    }
  } catch (e) {
    console.warn('Spotify open token fetch failed:', e);
  }

  return null;
}

// Fallback search using iTunes/Deezer search if Spotify token is unavailable
async function fallbackSearch(q, country = 'IN') {
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=${country}&media=music&entity=song&limit=20`);
    if (res.ok) {
      const data = await res.json();
      return (data.results || []).map((t) => {
        const durationSec = Math.floor((t.trackTimeMillis || 0) / 1000);
        const m = Math.floor(durationSec / 60);
        const s = String(durationSec % 60).padStart(2, '0');
        return {
          id: `itunes-${t.trackId}`,
          spotifyId: String(t.trackId),
          title: t.trackName,
          author: t.artistName,
          thumbnail: (t.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
          duration: `${m}:${s}`,
          album: t.collectionName || '',
          platform: 'Spotify',
          type: 'spotify',
        };
      });
    }
  } catch (err) {
    console.warn('Fallback music search failed:', err);
  }
  return [];
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').trim();
  const market = (searchParams.get('market') || searchParams.get('gl') || 'IN').toUpperCase();

  if (!q) {
    return NextResponse.json({ results: [] });
  }

  const token = await getSpotifyToken();

  if (token) {
    try {
      const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&market=${market}&limit=20`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        const items = data.tracks?.items || [];

        const results = items.map((t) => {
          const durationSec = Math.floor((t.duration_ms || 0) / 1000);
          const m = Math.floor(durationSec / 60);
          const s = String(durationSec % 60).padStart(2, '0');
          const thumbnail = t.album?.images?.[0]?.url || t.album?.images?.[1]?.url || '';
          const author = (t.artists || []).map((a) => a.name).join(', ');

          return {
            id: `spotify-${t.id}`,
            spotifyId: t.id,
            title: t.name,
            author,
            thumbnail,
            duration: `${m}:${s}`,
            album: t.album?.name || '',
            url: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
            platform: 'Spotify',
            type: 'spotify',
          };
        });

        if (results.length > 0) {
          return NextResponse.json({ results });
        }
      }
    } catch (err) {
      console.warn('Spotify search API error:', err);
    }
  }

  // Fallback if Spotify token is blocked / rate-limited
  const fallbackResults = await fallbackSearch(q, market);
  return NextResponse.json({ results: fallbackResults });
}
