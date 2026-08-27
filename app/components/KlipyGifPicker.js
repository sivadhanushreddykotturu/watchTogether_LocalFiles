'use client';

import React, { useState, useEffect, useRef } from 'react';

export default function KlipyGifPicker({ onSelectGif, onClose, adultMode = false }) {
  const [provider, setProvider] = useState('klipy');
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsKey, setNeedsKey] = useState(false);
  const searchTimeoutRef = useRef(null);
  const containerRef = useRef(null);
  const providerRef = useRef(provider);

  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  useEffect(() => {
    if (!adultMode && provider === 'redgifs') {
      handleProviderSwitch('klipy');
    }
  }, [adultMode]);

  const fetchGifs = async (searchQuery, activeProvider = providerRef.current) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/gifs?provider=${activeProvider}&q=${encodeURIComponent(searchQuery || '')}`);
      const data = await res.json();
      if (data.needsKey) {
        setNeedsKey(true);
        setError('KLIPY API Key required. Set KLIPY_API_KEY in Render environment variables.');
        setGifs([]);
      } else if (data.ok && Array.isArray(data.results)) {
        setGifs(data.results);
        setNeedsKey(false);
        setError('');
      } else {
        setGifs([]);
        setError(data.error || 'Failed to load GIFs');
      }
    } catch (err) {
      setGifs([]);
      setError(err.message || 'Error connecting to GIF service');
    } finally {
      setLoading(false);
    }
  };

  // Initial load: trending GIFs
  useEffect(() => {
    fetchGifs('', provider);
  }, []);

  const handleProviderSwitch = (p) => {
    if (p === provider) return;
    setProvider(p);
    providerRef.current = p;
    setGifs([]);
    setError('');
    fetchGifs(query, p);
  };

  const handleSearchChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      fetchGifs(val, providerRef.current);
    }, 280);
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    fetchGifs(query, providerRef.current);
  };

  return (
    <div className="tenor-gif-picker" ref={containerRef}>
      <div className="tgp-tabs">
        <button
          type="button"
          className={'tgp-tab' + (provider === 'klipy' ? ' active' : '')}
          onClick={() => handleProviderSwitch('klipy')}
        >
          🎭 KLIPY
        </button>
        {adultMode && (
          <button
            type="button"
            className={'tgp-tab' + (provider === 'redgifs' ? ' active' : '')}
            onClick={() => handleProviderSwitch('redgifs')}
          >
            🔞 RedGIFs
          </button>
        )}
      </div>

      <div className="tgp-head">
        <form className="tgp-search-wrap" onSubmit={handleSearchSubmit}>
          <svg className="tgp-search-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            className="tgp-search-input"
            placeholder={provider === 'redgifs' ? 'Search RedGIFs…' : 'Search KLIPY…'}
            value={query}
            onChange={handleSearchChange}
            autoFocus
          />
          {query && (
            <button
              type="button"
              className="tgp-clear-search-btn"
              onClick={() => {
                setQuery('');
                fetchGifs('', providerRef.current);
              }}
              title="Clear search"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--dim)',
                cursor: 'pointer',
                fontSize: '12px',
                padding: '0 4px',
                display: 'flex',
                alignItems: 'center'
              }}
            >
              ✕
            </button>
          )}
        </form>
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

        {!loading && error && gifs.length === 0 && (
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
              {gif.previewUrl?.includes('.mp4') || gif.isVideo ? (
                <video
                  src={gif.previewUrl}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="tgp-img"
                />
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={gif.previewUrl}
                  alt={gif.title}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="tgp-img"
                />
              )}
              <div className="tgp-item-overlay">
                <span className="tgp-send-label">Send</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="tgp-footer">
        <span className="tgp-powered">Powered by {provider === 'redgifs' ? 'RedGIFs' : 'KLIPY'}</span>
      </div>
    </div>
  );
}
