'use client';

import React, { useState, useEffect } from 'react';
import { fetchTmdbTvDetails, fetchTmdbSeason } from '../../lib/tmdb';

export default function TmdbEpisodeModal({
  isOpen,
  onClose,
  series, // { tmdbId, title || name, poster, backdrop, overview, year, rating }
  onSelectEpisode, // (item, playNow) => void
  currentSeason = 1,
  currentEpisode = 1,
}) {
  const [details, setDetails] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState(currentSeason || 1);
  const [seasonData, setSeasonData] = useState(null);
  const [loadingSeason, setLoadingSeason] = useState(false);
  const [error, setError] = useState('');

  const tmdbId = series?.tmdbId || series?.id;

  // 1. Fetch full series metadata (including seasons list)
  useEffect(() => {
    if (!isOpen || !tmdbId) return;

    let active = true;
    setLoadingDetails(true);
    setError('');

    fetchTmdbTvDetails(tmdbId)
      .then((data) => {
        if (!active) return;
        if (data) {
          setDetails(data);
          // Pick initial season: user's currentSeason if valid, else first regular season (usually season 1)
          const validSeasons = (data.seasons || []).filter((s) => s.seasonNumber > 0);
          const initialSeason =
            currentSeason && validSeasons.some((s) => s.seasonNumber === currentSeason)
              ? currentSeason
              : validSeasons[0]?.seasonNumber || 1;
          setSelectedSeason(initialSeason);
        } else {
          setError('Failed to load series details.');
        }
        setLoadingDetails(false);
      })
      .catch((err) => {
        if (!active) return;
        console.error('Error fetching TV details:', err);
        setError('Error loading series details.');
        setLoadingDetails(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, tmdbId, currentSeason]);

  // 2. Fetch episodes whenever selectedSeason changes
  useEffect(() => {
    if (!isOpen || !tmdbId || !selectedSeason) return;

    let active = true;
    setLoadingSeason(true);

    fetchTmdbSeason(tmdbId, selectedSeason)
      .then((data) => {
        if (!active) return;
        if (data && data.ok) {
          setSeasonData(data);
        } else {
          setSeasonData(null);
        }
        setLoadingSeason(false);
      })
      .catch((err) => {
        if (!active) return;
        console.error('Error loading season episodes:', err);
        setSeasonData(null);
        setLoadingSeason(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, tmdbId, selectedSeason]);

  if (!isOpen) return null;

  const showTitle = details?.name || series?.title || series?.name || 'TV Series';
  const showBackdrop = details?.backdrop || series?.backdrop || details?.poster || series?.poster;
  const showPoster = details?.poster || series?.poster;
  const regularSeasons = (details?.seasons || []).filter((s) => s.seasonNumber > 0);
  const specials = (details?.seasons || []).filter((s) => s.seasonNumber === 0);
  const allSeasons = [...regularSeasons, ...specials];

  const handlePlayEpisode = (ep, playNow = true) => {
    if (!onSelectEpisode) return;
    onSelectEpisode(
      {
        tmdbId,
        mediaType: 'tv',
        season: selectedSeason,
        episode: ep.episodeNumber,
        episodeTitle: ep.name,
        showTitle,
        poster: ep.still || showPoster,
        backdrop: showBackdrop,
        title: `${showTitle} · S${selectedSeason}:E${ep.episodeNumber} "${ep.name}"`,
      },
      playNow
    );
  };

  return (
    <div className="tmdb-modal-backdrop" onClick={onClose}>
      <div className="tmdb-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header Hero Banner */}
        <div
          className="tmdb-modal-hero"
          style={{
            backgroundImage: showBackdrop ? `linear-gradient(to bottom, rgba(17, 20, 29, 0.4), #11141d 95%), url("${showBackdrop}")` : undefined,
          }}
        >
          <button className="tmdb-modal-close" onClick={onClose} title="Close (Esc)">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>

          <div className="tmdb-modal-hero-content">
            {showPoster && (
              <img src={showPoster} alt={showTitle} className="tmdb-modal-poster" referrerPolicy="no-referrer" />
            )}
            <div className="tmdb-modal-hero-info">
              <div className="tmdb-modal-badges">
                <span className="tmdb-badge type">TV SERIES</span>
                {details?.rating && <span className="tmdb-badge rating">⭐ {details.rating}</span>}
                {details?.year && <span className="tmdb-badge year">{details.year}</span>}
                {details?.status && <span className="tmdb-badge status">{details.status}</span>}
              </div>

              <h2 className="tmdb-modal-title">{showTitle}</h2>

              {details?.genres && details.genres.length > 0 && (
                <div className="tmdb-genres">
                  {details.genres.map((g) => (
                    <span key={g} className="tmdb-genre-tag">
                      {g}
                    </span>
                  ))}
                </div>
              )}

              <p className="tmdb-modal-overview">{details?.overview || series?.overview || 'No description available.'}</p>

              {/* Quick Play First Episode button */}
              <div className="tmdb-hero-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    const firstEp = seasonData?.episodes?.[0] || { episodeNumber: 1, name: 'Episode 1' };
                    handlePlayEpisode(firstEp, true);
                  }}
                >
                  <span style={{ fontSize: '15px' }}>▶</span> Play S1:E1
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Seasons Bar */}
        <div className="tmdb-seasons-bar">
          <div className="tmdb-seasons-scroll">
            {loadingDetails ? (
              <span className="tmdb-loading-text">Loading seasons…</span>
            ) : allSeasons.length > 0 ? (
              allSeasons.map((s) => (
                <button
                  key={s.seasonNumber}
                  type="button"
                  className={'tmdb-season-tab' + (selectedSeason === s.seasonNumber ? ' active' : '')}
                  onClick={() => setSelectedSeason(s.seasonNumber)}
                >
                  {s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`}
                  <span className="tmdb-ep-count">({s.episodeCount} eps)</span>
                </button>
              ))
            ) : (
              <button type="button" className="tmdb-season-tab active">
                Season 1
              </button>
            )}
          </div>
        </div>

        {/* Episodes Body */}
        <div className="tmdb-episodes-container">
          {error ? (
            <div className="tmdb-error-box">{error}</div>
          ) : loadingSeason ? (
            <div className="tmdb-episodes-loading">
              <div className="yt-search-spinner-lg" />
              <p>Fetching Season {selectedSeason} episodes…</p>
            </div>
          ) : seasonData?.episodes && seasonData.episodes.length > 0 ? (
            <div className="tmdb-episodes-grid">
              {seasonData.episodes.map((ep) => {
                const isCurrent =
                  currentSeason === selectedSeason && currentEpisode === ep.episodeNumber;

                return (
                  <div key={ep.id || ep.episodeNumber} className={'tmdb-ep-card' + (isCurrent ? ' playing-now' : '')}>
                    <div
                      className="tmdb-ep-thumb-wrap"
                      onClick={() => handlePlayEpisode(ep, true)}
                      title={`Play Episode ${ep.episodeNumber}`}
                    >
                      {ep.still ? (
                        <img
                          src={ep.still}
                          alt={ep.name}
                          className="tmdb-ep-thumb"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="tmdb-ep-thumb placeholder">
                          <span>EP {ep.episodeNumber}</span>
                        </div>
                      )}
                      <div className="tmdb-ep-play-overlay">
                        <svg viewBox="0 0 24 24" width="28" height="28" fill="white">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                      {ep.runtime && <span className="tmdb-ep-runtime">{ep.runtime}</span>}
                    </div>

                    <div className="tmdb-ep-info">
                      <div className="tmdb-ep-top-row">
                        <span className="tmdb-ep-number">EP {ep.episodeNumber}</span>
                        {ep.airDate && <span className="tmdb-ep-airdate">{ep.airDate}</span>}
                        {ep.rating && <span className="tmdb-ep-rate">⭐ {ep.rating}</span>}
                      </div>

                      <h4 className="tmdb-ep-title" title={ep.name}>
                        {ep.name || `Episode ${ep.episodeNumber}`}
                      </h4>

                      <p className="tmdb-ep-overview">
                        {ep.overview || 'No synopsis available for this episode.'}
                      </p>

                      <div className="tmdb-ep-actions">
                        <button
                          type="button"
                          className="btn primary sm"
                          onClick={() => handlePlayEpisode(ep, true)}
                          title="Play now for everyone in the room"
                        >
                          ▶ Play Now
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => handlePlayEpisode(ep, false)}
                          title="Add this episode to queue"
                        >
                          + Queue
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="tmdb-no-episodes">
              <p>No episodes found for this season.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
