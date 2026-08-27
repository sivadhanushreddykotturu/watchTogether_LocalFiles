'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser, SignInButton } from '@clerk/nextjs';
import { getSocket } from '../lib/socket';
import { ThemeToggle } from './components/ThemeToggle';

export default function LandingPage(): React.JSX.Element {
  const router = useRouter();
  const { user, isLoaded, isSignedIn } = useUser();
  const [name, setName] = useState<string>('');
  const [code, setCode] = useState<string>('');
  const [loading, setLoading] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [showInstantJoin, setShowInstantJoin] = useState<boolean>(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // If user is already logged in, automatically take them to their dashboard
    if (isLoaded && isSignedIn) {
      router.replace('/dashboard');
    }
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    try {
      getSocket();
    } catch {
      /* ignore */
    }

    const saved = sessionStorage.getItem('reelsync:name');
    if (saved) setName(saved);

    const urlCode = new URLSearchParams(window.location.search).get('room');
    if (urlCode) {
      setCode(urlCode.toUpperCase().slice(0, 5));
      setShowInstantJoin(true);
    }
  }, []);

  function enter(res: { error?: string; self?: { name: string }; code?: string }): void {
    setLoading('');
    if (!res || res.error) {
      setError((res && res.error) || 'Something went wrong.');
      return;
    }
    if (res.self?.name) {
      sessionStorage.setItem('reelsync:name', res.self.name);
    }
    router.push(`/room/${res.code}`);
  }

  const startInstantParty = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const trimmedName = name.trim() || 'Guest Host';
    setLoading('instant');
    sessionStorage.setItem('reelsync:name', trimmedName);

    // Instant meetings have no ownerId (non-persistent)
    getSocket().emit(
      'create-room',
      {
        name: trimmedName,
        title: `${trimmedName}'s Instant Party`,
        ownerId: null,
        controlLock: false,
        sessionId: typeof window !== 'undefined' ? localStorage.getItem('reelsync:sessionId') : null,
      },
      enter
    );
  };

  const joinParty = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const trimmedName = name.trim() || 'Guest';
    const joinCode = code.trim().toUpperCase();

    if (!joinCode) {
      setError('Please enter the 5-letter room code.');
      return;
    }

    setLoading('join');
    sessionStorage.setItem('reelsync:name', trimmedName);
    getSocket().emit(
      'join-room',
      {
        code: joinCode,
        name: trimmedName,
        sessionId: typeof window !== 'undefined' ? localStorage.getItem('reelsync:sessionId') : null,
      },
      enter
    );
  };

  if (isLoaded && isSignedIn) {
    return (
      <main className="minimal-landing">
        <div className="min-empty-rooms" style={{ maxWidth: '360px', margin: '0 auto' }}>
          <div className="tgp-spinner" style={{ margin: '0 auto 16px' }} />
          <p style={{ margin: 0, fontWeight: 500 }}>Opening your dashboard…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="minimal-landing">
      <div className="minimal-container" style={{ maxWidth: '520px' }}>
        {/* Top Header */}
        <header className="minimal-header">
          <div className="minimal-brand">
            <span className="mb-icon">✦</span>
            <span>REELSYNC</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <ThemeToggle />
            <SignInButton mode="modal">
              <button type="button" className="min-btn ghost" style={{ fontSize: '13px', padding: '6px 14px' }}>
                Sign in
              </button>
            </SignInButton>
          </div>
        </header>

        {/* Main Landing Hero Card */}
        <div className="minimal-card">
          <div className="minimal-hero">
            <div style={{ display: 'inline-flex', marginBottom: '12px' }}>
              <span className="tab-pill" style={{ letterSpacing: '0.12em', color: 'var(--accent)', borderColor: 'var(--accent-soft)', background: 'var(--accent-soft)' }}>
                ✦ SYNCED STREAMING
              </span>
            </div>
            <h1 className="minimal-title">Watch Together in Lockstep</h1>
            <p className="minimal-desc">
              Watch local video files, YouTube, and streams with friends in millisecond sync with voice chat and live reactions.
            </p>
          </div>

          {/* Primary Action: Sign in to Dashboard */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '22px' }}>
            <SignInButton mode="modal">
              <button type="button" className="min-btn primary" style={{ padding: '14px', fontSize: '15px' }}>
                Sign in to Dashboard →
              </button>
            </SignInButton>
            <span style={{ fontSize: '12px', color: 'var(--theme-text-dim)', textAlign: 'center' }}>
              Persistent rooms, host controls, and history
            </span>
          </div>

          {/* Subtle Divider */}
          <div className="divider" style={{ margin: '14px 0 18px' }}>
            <span>or join as guest</span>
          </div>

          {/* Guest Action Switcher */}
          {!showInstantJoin ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <button
                type="button"
                className="min-btn ghost"
                style={{ fontSize: '13px' }}
                onClick={() => setShowInstantJoin(true)}
              >
                ⚡ Instant Party
              </button>
              <button
                type="button"
                className="min-btn ghost"
                style={{ fontSize: '13px' }}
                onClick={() => setShowInstantJoin(true)}
              >
                🔑 Enter Code
              </button>
            </div>
          ) : (
            <div className="minimal-form">
              <div className="min-field">
                <label className="min-label">Your Name</label>
                <input
                  ref={nameInputRef}
                  type="text"
                  maxLength={24}
                  placeholder="e.g. Nani"
                  autoComplete="off"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError('');
                  }}
                  className="min-input"
                />
              </div>

              <div className="min-field">
                <label className="min-label">Room Code (Leave blank for new party)</label>
                <input
                  type="text"
                  maxLength={5}
                  placeholder="5-letter code"
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.toUpperCase());
                    setError('');
                  }}
                  className="min-input code-input"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '6px' }}>
                <button
                  type="button"
                  className="min-btn ghost"
                  onClick={startInstantParty}
                  disabled={loading !== ''}
                >
                  {loading === 'instant' ? 'Starting…' : '⚡ Instant Party'}
                </button>
                <button
                  type="button"
                  className="min-btn primary"
                  onClick={joinParty}
                  disabled={loading !== '' || !code.trim()}
                >
                  {loading === 'join' ? 'Joining…' : 'Join Room →'}
                </button>
              </div>
            </div>
          )}

          {error && <div className="min-error" role="alert">{error}</div>}
        </div>

        <footer className="minimal-footer">
          Peer-synchronized streaming. Local video files remain on your device.
        </footer>
      </div>
    </main>
  );
}
