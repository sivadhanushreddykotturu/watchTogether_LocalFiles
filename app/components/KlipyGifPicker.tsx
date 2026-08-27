'use client';

import React, { useState, useEffect, useRef } from 'react';

export interface GifItem {
  id: string;
  url: string;
  previewUrl: string;
  title: string;
  width?: number;
  height?: number;
  isVideo?: boolean;
}

interface KlipyGifPickerProps {
  onSelectGif: (gif: GifItem) => void;
  onClose: () => void;
  adultMode?: boolean;
}

export default function KlipyGifPicker({
  onSelectGif,
  onClose,
  adultMode = false,
}: KlipyGifPickerProps): React.JSX.Element {
  const [provider, setProvider] = useState<'klipy' | 'redgifs'>('klipy');
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsKey, setNeedsKey] = useState(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const providerRef = useRef(provider);

  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  useEffect(() => {
    if (!adultMode && provider === 'redgifs') {
      handleProviderSwitch('klipy');
    }
  }, [adultMode]);

  const fetchGifs = async (searchQuery: string, activeProvider = providerRef.current) => {
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
    } catch (err: any) {
      setGifs([]);
      setError(err?.message || 'Error connecting to GIF service');
    } finally {
      setLoading(false);
    }
  };

  // Initial load: trending GIFs
  useEffect(() => {
    fetchGifs('', provider);
  }, []);

  const handleProviderSwitch = (p: 'klipy' | 'redgifs') => {
    if (p === provider) return;
    setProvider(p);
    providerRef.current = p;
    setGifs([]);
    setError('');
    fetchGifs(query, p);
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      fetchGifs(val, providerRef.current);
    }, 280);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
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

      <div className="tgp-header">
        <form onSubmit={handleSearchSubmit} className="tgp-search-form">
          <input
            type="text"
            className="tgp-search-input"
            placeholder={
              provider === 'redgifs'
                ? 'Search RedGIFs loops (e.g. anime, dance)…'
                : 'Search GIFs via KLIPY (e.g. popcorn, laugh)…'
            }
            value={query}
            onChange={handleSearchChange}
            autoFocus
          />
          {query && (
            <button
              type="button"
              className="tgp-search-clear"
              onClick={() => {
                setQuery('');
                fetchGifs('', providerRef.current);
              }}
            >
              ✕
            </button>
          )}
        </form>
        <button type="button" className="tgp-close" onClick={onClose} title="Close GIF picker">
          ✕
        </button>
      </div>

      <div className="tgp-grid">
        {loading && gifs.length === 0 && (
          <div className="tgp-empty">
            <div className="tgp-spinner" />
            <p>Loading GIFs…</p>
          </div>
        )}

        {error && gifs.length === 0 && !loading && (
          <div className="tgp-empty tgp-error">
            <p>⚠️ {error}</p>
            {needsKey && (
              <a
                href="https://partner.klipy.com"
                target="_blank"
                rel="noreferrer"
                className="tgp-key-link"
              >
                Get free KLIPY API key →
              </a>
            )}
          </div>
        )}

        {!loading && !error && gifs.length === 0 && (
          <div className="tgp-empty">
            <p>No GIFs found for &ldquo;{query}&rdquo;</p>
          </div>
        )}

        {gifs.map((gif) => {
          const isVideo = gif.isVideo || gif.url?.endsWith('.mp4') || gif.previewUrl?.endsWith('.mp4');
          return (
            <button
              key={gif.id}
              type="button"
              className="tgp-item"
              onClick={() => onSelectGif(gif)}
              title={gif.title || 'Send GIF'}
            >
              {isVideo ? (
                <video
                  src={gif.previewUrl || gif.url}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="tgp-img"
                  style={{ objectFit: 'cover', width: '100%', height: '100%' }}
                />
              ) : (
                <img
                  src={gif.previewUrl || gif.url}
                  alt={gif.title || 'GIF'}
                  loading="lazy"
                  className="tgp-img"
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="tgp-footer">
        <span>Powered by {provider === 'redgifs' ? 'RedGIFs' : 'KLIPY'}</span>
      </div>
    </div>
  );
}
