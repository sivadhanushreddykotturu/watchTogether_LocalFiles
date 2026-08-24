'use client';

import React, { useState, useEffect, useRef } from 'react';

export default function KlipyGifPicker({ onSelectGif, onClose }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsKey, setNeedsKey] = useState(false);
  const searchTimeoutRef = useRef(null);
  const containerRef = useRef(null);

  const fetchGifs = async (searchQuery) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/gifs?q=' + encodeURIComponent(searchQuery || ''));
      const data = await res.json();
      if (data.needsKey) {
        setNeedsKey(true);
        setError('KLIPY API Key required. Set KLIPY_API_KEY in Render environment variables.');
        setGifs([]);
      } else if (data.ok && Array.isArray(data.results)) {
        setGifs(data.results);
        setNeedsKey(false);
        if (data.results.length === 0) {
          setError(searchQuery ? `No GIFs found for "${searchQuery}"` : 'No trending GIFs found.');
        }
      } else {
        setError(data.error || 'Failed to load GIFs');
      }
    } catch (err) {
      setError(err.message || 'Error connecting to GIF service');
    } finally {
      setLoading(false);
    }
  };

  // Initial load: trending GIFs
  useEffect(() => {
    fetchGifs('');
  }, []);

  const handleSearchChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      fetchGifs(val);
    }, 350);
  };

  return (
    <div className="tenor-gif-picker" ref={containerRef}>
      <div className="tgp-head">
        <div className="tgp-search-wrap">
          <svg className="tgp-search-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            className="tgp-search-input"
            placeholder="Search KLIPY"
            value={query}
            onChange={handleSearchChange}
            autoFocus
          />
        </div>
        {onClose && (
          <button
            type="button"
            className="tgp-close-btn"
            onClick={onClose}
            title="Close GIF picker"
            aria-label="Close"
          >
            ✕
          </button>
        )}
      </div>

      <div className="tgp-grid-container">
        {loading && gifs.length === 0 && (
          <div className="tgp-loading-wrap">
            <div className="tgp-spinner" />
            <span>Finding the best GIFs...</span>
          </div>
        )}

        {error && (
          <div className="tgp-error-wrap">
            <span className="tgp-error-icon">⚠️</span>
            <p className="tgp-error-text">{error}</p>
            {needsKey && (
              <p className="tgp-error-hint">
                Get a free key from <a href="https://partner.klipy.com" target="_blank" rel="noopener noreferrer">KLIPY Partner Dashboard</a> and add it as <code>KLIPY_API_KEY</code>.
              </p>
            )}
          </div>
        )}

        {!loading && !error && gifs.length === 0 && (
          <div className="tgp-empty-wrap">
            <span>No GIFs found for &quot;{query}&quot;</span>
          </div>
        )}

        <div className="tgp-grid">
          {gifs.map((gif) => (
            <div
              key={gif.id}
              className="tgp-item"
              onClick={() => onSelectGif && onSelectGif(gif)}
              title={gif.title}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={gif.previewUrl}
                alt={gif.title}
                loading="lazy"
                className="tgp-img"
              />
              <div className="tgp-item-overlay">
                <span className="tgp-send-label">Send</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="tgp-footer">
        <span className="tgp-powered">Powered by KLIPY</span>
      </div>
    </div>
  );
}
