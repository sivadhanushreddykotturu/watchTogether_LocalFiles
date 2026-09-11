'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

const POPULAR_TAGS = ['trending', 'hot', 'verified', 'asian', 'milf', 'bdsm', 'cosplay', 'creampie', 'amateur'];

export default function ShortsModal({
  isOpen,
  onClose,
  socket,
  roomCode,
  isHost,
  onPlayForRoom,
  onAddToQueue,
}) {
  const [clips, setClips] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [currentTag, setCurrentTag] = useState('trending');
  const [customSearch, setCustomSearch] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [roomSyncEnabled, setRoomSyncEnabled] = useState(true);
  const [syncNotice, setSyncNotice] = useState('');

  const containerRef = useRef(null);
  const videoRefs = useRef({});
  const touchStartY = useRef(0);
  const isScrollingRef = useRef(false);
  const syncTimeoutRef = useRef(null);

  // Fetch clips from our backend API
  const fetchClips = useCallback(async (tagToFetch = currentTag, pageToFetch = 1, append = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/shorts?tag=${encodeURIComponent(tagToFetch)}&page=${pageToFetch}&count=25`);
      if (res.ok) {
        const data = await res.json();
        const newClips = Array.isArray(data.clips) ? data.clips : [];
        if (append) {
          setClips((prev) => {
            const existingIds = new Set(prev.map((c) => c.id));
            const filtered = newClips.filter((c) => !existingIds.has(c.id));
            return [...prev, ...filtered];
          });
        } else {
          setClips(newClips);
          setCurrentIndex(0);
        }
      }
    } catch (err) {
      console.error('[Shorts] Failed to fetch:', err);
    } finally {
      setLoading(false);
    }
  }, [currentTag]);

  // Initial load when modal opens
  useEffect(() => {
    if (isOpen && clips.length === 0) {
      fetchClips(currentTag, 1, false);
    }
  }, [isOpen, fetchClips, currentTag, clips.length]);

  // Auto-paginate when near the end of the clips list
  useEffect(() => {
    if (clips.length > 0 && currentIndex >= clips.length - 4 && !loading) {
      const nextPage = page + 1;
      setPage(nextPage);
      fetchClips(currentTag, nextPage, true);
    }
  }, [currentIndex, clips.length, loading, page, currentTag, fetchClips]);

  // Handle room synchronization when someone else scrolls
  useEffect(() => {
    if (!socket || !isOpen) return;

    const handleShortsSync = ({ clipId, index, isPlaying: syncPlaying, userName }) => {
      if (!roomSyncEnabled) return;
      if (typeof index === 'number' && index >= 0) {
        setSyncNotice(`${userName || 'Someone'} scrolled to reel #${index + 1}`);
        clearTimeout(syncTimeoutRef.current);
        syncTimeoutRef.current = setTimeout(() => setSyncNotice(''), 3000);

        setCurrentIndex(index);
        if (typeof syncPlaying === 'boolean') {
          setIsPlaying(syncPlaying);
        }
      }
    };

    socket.on('shorts-sync', handleShortsSync);
    return () => {
      socket.off('shorts-sync', handleShortsSync);
    };
  }, [socket, isOpen, roomSyncEnabled]);

  // Broadcast our scroll position to room members
  const broadcastSync = useCallback((newIndex, playingState = true) => {
    if (!socket || !roomSyncEnabled) return;
    const clip = clips[newIndex];
    if (clip) {
      socket.emit('shorts-sync', {
        clipId: clip.id,
        index: newIndex,
        isPlaying: playingState,
      });
    }
  }, [socket, roomSyncEnabled, clips]);

  const goToNext = useCallback(() => {
    if (currentIndex < clips.length - 1) {
      const nextIdx = currentIndex + 1;
      setCurrentIndex(nextIdx);
      setIsPlaying(true);
      broadcastSync(nextIdx, true);
    }
  }, [currentIndex, clips.length, broadcastSync]);

  const goToPrev = useCallback(() => {
    if (currentIndex > 0) {
      const prevIdx = currentIndex - 1;
      setCurrentIndex(prevIdx);
      setIsPlaying(true);
      broadcastSync(prevIdx, true);
    }
  }, [currentIndex, broadcastSync]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        goToNext();
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        goToPrev();
      } else if (e.key === ' ') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.key === 'm') {
        e.preventDefault();
        setIsMuted((m) => !m);
      } else if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, goToNext, goToPrev, onClose]);

  // Mouse wheel snap scrolling
  const handleWheel = (e) => {
    if (isScrollingRef.current) return;
    if (Math.abs(e.deltaY) > 40) {
      isScrollingRef.current = true;
      if (e.deltaY > 0) {
        goToNext();
      } else {
        goToPrev();
      }
      setTimeout(() => {
        isScrollingRef.current = false;
      }, 550);
    }
  };

  // Mobile Touch Swipe Handling
  const handleTouchStart = (e) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e) => {
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(deltaY) > 45) {
      if (deltaY < 0) {
        goToNext(); // Swipe Up -> Next Video
      } else {
        goToPrev(); // Swipe Down -> Prev Video
      }
    }
  };

  // Manage active and preloaded video elements
  useEffect(() => {
    Object.entries(videoRefs.current).forEach(([idxStr, vid]) => {
      if (!vid) return;
      const idx = parseInt(idxStr, 10);
      if (idx === currentIndex) {
        vid.muted = isMuted;
        if (isPlaying) {
          vid.play().catch(() => {
            // If browser blocks unmuted autoplay, mute and retry
            vid.muted = true;
            setIsMuted(true);
            vid.play().catch(() => {});
          });
        } else {
          vid.pause();
        }
      } else if (idx === currentIndex + 1) {
        // Preload next video: buffer data silently
        vid.muted = true;
        vid.pause();
        vid.currentTime = 0;
        vid.load();
      } else {
        // Pause all other videos
        vid.pause();
      }
    });
  }, [currentIndex, isPlaying, isMuted]);

  const handleTagChange = (tag) => {
    setCurrentTag(tag);
    setCustomSearch('');
    setPage(1);
    fetchClips(tag, 1, false);
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (!customSearch.trim()) return;
    setCurrentTag(customSearch.trim());
    setPage(1);
    fetchClips(customSearch.trim(), 1, false);
  };

  if (!isOpen) return null;

  const currentClip = clips[currentIndex];
  // Next clip for prefetching
  const nextClip = clips[currentIndex + 1];
  // Subsequent clip for poster preload
  const upcomingClip = clips[currentIndex + 2];

  return (
    <div className="shorts-overlay" onWheel={handleWheel}>
      {/* Background Dim */}
      <div className="shorts-backdrop" onClick={onClose} />

      {/* Top Header Controls */}
      <div className="shorts-header">
        <div className="shorts-brand">
          <span className="shorts-icon">⚡</span>
          <span className="shorts-title">Reels</span>
          {syncNotice && <span className="shorts-sync-toast">{syncNotice}</span>}
        </div>

        {/* Tag Category Pills */}
        <div className="shorts-tags-bar">
          {POPULAR_TAGS.map((t) => (
            <button
              key={t}
              type="button"
              className={`shorts-tag-chip ${currentTag === t && !customSearch ? 'active' : ''}`}
              onClick={() => handleTagChange(t)}
            >
              #{t}
            </button>
          ))}
          <form onSubmit={handleSearchSubmit} className="shorts-search-form">
            <input
              type="text"
              className="shorts-search-input"
              placeholder="Search tag..."
              value={customSearch}
              onChange={(e) => setCustomSearch(e.target.value)}
            />
          </form>
        </div>

        <div className="shorts-top-actions">
          <button
            type="button"
            className={`shorts-btn-pill ${roomSyncEnabled ? 'synced' : ''}`}
            onClick={() => setRoomSyncEnabled((s) => !s)}
            title={roomSyncEnabled ? 'Synced with room (Everyone scrolls together)' : 'Personal browsing mode (Sync OFF)'}
          >
            {roomSyncEnabled ? '🔗 Synced' : '🔓 Solo'}
          </button>
          <button type="button" className="shorts-close-btn" onClick={onClose} title="Close Reels (Esc)">
            ✕
          </button>
        </div>
      </div>

      {/* Center Phone/Reels Viewport */}
      <div
        className="shorts-viewport"
        ref={containerRef}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {clips.length === 0 && loading ? (
          <div className="shorts-loading-state">
            <div className="spinner" />
            <p>Loading Reels...</p>
          </div>
        ) : !currentClip ? (
          <div className="shorts-loading-state">
            <p>No reels found for #{currentTag}.</p>
            <button className="btn primary sm" onClick={() => handleTagChange('trending')}>
              Back to Trending
            </button>
          </div>
        ) : (
          <div className="shorts-card-active">
            {/* Active Video Player */}
            <video
              ref={(el) => {
                videoRefs.current[currentIndex] = el;
              }}
              src={currentClip.url}
              poster={currentClip.poster}
              className="shorts-video"
              loop
              playsInline
              autoPlay
              referrerPolicy="no-referrer"
              crossOrigin="anonymous"
              muted={isMuted}
              onClick={() => setIsPlaying((p) => !p)}
            />

            {/* Hidden Preloaded Next Video (Zero-Lag Transition Buffer) */}
            {nextClip && (
              <video
                ref={(el) => {
                  videoRefs.current[currentIndex + 1] = el;
                }}
                src={nextClip.url}
                poster={nextClip.poster}
                preload="auto"
                muted
                referrerPolicy="no-referrer"
                crossOrigin="anonymous"
                style={{ display: 'none' }}
              />
            )}

            {/* Prefetch Network Cache Link for Upcoming Clip */}
            {upcomingClip && (
              <link rel="prefetch" href={upcomingClip.url} as="video" />
            )}

            {/* Play/Pause Overlay Indicator */}
            {!isPlaying && (
              <div className="shorts-play-indicator" onClick={() => setIsPlaying(true)}>
                <span>▶</span>
              </div>
            )}

            {/* Video Meta Info (Left Bottom) */}
            <div className="shorts-meta-overlay">
              <div className="shorts-author-row">
                <span className="shorts-author-badge">@{currentClip.author}</span>
                {currentClip.isVertical && <span className="shorts-hd-pill">9:16 HD</span>}
              </div>
              <p className="shorts-caption">{currentClip.title}</p>
              {currentClip.tags && currentClip.tags.length > 0 && (
                <div className="shorts-meta-tags">
                  {currentClip.tags.map((tag) => (
                    <span key={tag} className="shorts-meta-tag" onClick={() => handleTagChange(tag)}>
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Right Action Sidebar */}
            <div className="shorts-actions-sidebar">
              {/* Sound Toggle */}
              <button
                type="button"
                className="shorts-action-icon-btn"
                onClick={() => setIsMuted((m) => !m)}
                title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
              >
                <span className="icon">{isMuted ? '🔇' : '🔊'}</span>
                <span className="label">{isMuted ? 'Muted' : 'Sound'}</span>
              </button>

              {/* Play for Room / Cast */}
              <button
                type="button"
                className="shorts-action-icon-btn highlight"
                onClick={() => {
                  if (onPlayForRoom) {
                    onPlayForRoom(currentClip);
                    onClose();
                  }
                }}
                title="Play on Main Screen for Room"
              >
                <span className="icon">📺</span>
                <span className="label">Cast</span>
              </button>

              {/* Add to Queue */}
              <button
                type="button"
                className="shorts-action-icon-btn"
                onClick={() => {
                  if (onAddToQueue) {
                    onAddToQueue(currentClip);
                  }
                }}
                title="Add Reel to Room Queue"
              >
                <span className="icon">➕</span>
                <span className="label">Queue</span>
              </button>
            </div>

            {/* Floating Up/Down Arrows for Desktop Navigation */}
            <div className="shorts-nav-arrows">
              <button
                type="button"
                className="shorts-arrow-btn prev"
                onClick={goToPrev}
                disabled={currentIndex === 0}
                title="Previous Reel (↑)"
              >
                ▲
              </button>
              <button
                type="button"
                className="shorts-arrow-btn next"
                onClick={goToNext}
                disabled={currentIndex >= clips.length - 1}
                title="Next Reel (↓)"
              >
                ▼
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Progress Dots / Index */}
      {clips.length > 0 && (
        <div className="shorts-footer-counter">
          <span>
            {currentIndex + 1} / {clips.length}
          </span>
        </div>
      )}
    </div>
  );
}
