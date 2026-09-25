'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser, SignInButton } from '@clerk/nextjs';
import { getSocket } from '../lib/socket';
import { ThemeToggle } from './components/ThemeToggle';
import { EmojiImg } from './components/AppleEmoji';

export default function LandingPage(): React.JSX.Element {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const [name, setName] = useState<string>('');
  const [code, setCode] = useState<string>('');
  const [loading, setLoading] = useState<string>('');
  const [error, setError] = useState<string>('');
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
      nameInputRef.current?.focus();
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

  const features = [
    { icon: '🔒', title: 'Files stay local', desc: 'Everyone streams their own copy of the file straight from their device — nothing is uploaded to a server.' },
    { icon: '⏱️', title: 'Frame-perfect sync', desc: 'Play, pause and seek propagate instantly, so nobody is ever a beat behind the group.' },
    { icon: '💬', title: 'Live chat & reactions', desc: 'React in real time, drop GIFs and emoji, and keep the conversation going alongside the film.' },
    { icon: '🎬', title: 'Subtitles built in', desc: 'Load your own subtitle track and adjust timing per-viewer without breaking sync for anyone else.' },
    { icon: '🖥️', title: 'Screen & tab share', desc: 'No local file? Share a browser tab or your whole screen and watch that together instead.' },
    { icon: '🔑', title: 'Host controls', desc: 'Lock playback control to the host, approve knock requests, and manage who’s in the room.' },
  ];

  return (
    <main className="lp-page">
      {/* Nav */}
      <header className="lp-nav">
        <div className="minimal-brand">
          <span className="mb-icon">✦</span>
          <span>REELSYNC</span>
        </div>
        <div className="lp-nav-actions">
          <ThemeToggle />
          <SignInButton mode="modal">
            <button type="button" className="min-btn ghost" style={{ fontSize: '13px', padding: '8px 16px' }}>
              Sign in
            </button>
          </SignInButton>
        </div>
      </header>

      {/* Hero */}
      <section className="lp-hero">
        <span className="lp-hero-badge tab-pill" style={{ letterSpacing: '0.12em', color: 'var(--accent)', borderColor: 'var(--accent-soft)', background: 'var(--accent-soft)' }}>
          ✦ SYNCED STREAMING
        </span>
        <h1 className="hero-title">
          Watch Together<br />
          in <span className="hero-accent">Lockstep</span>
        </h1>
        <p className="lp-hero-sub">
          Everyone opens their own copy of the same video — ReelSync keeps play, pause and seek in perfect sync across every screen. Your files never leave your device.
        </p>
      </section>

      {/* CTA card */}
      <div className="lp-cta-wrap">
        <div className="minimal-card">
          <div className="minimal-form">
            <div className="min-field">
              <label className="min-label" htmlFor="guest-name">Your name</label>
              <input
                ref={nameInputRef}
                id="guest-name"
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

            <button
              type="button"
              className="min-btn primary"
              style={{ padding: '14px', fontSize: '15px' }}
              onClick={startInstantParty}
              disabled={loading !== ''}
            >
              {loading === 'instant' ? 'Starting…' : <><EmojiImg char="⚡" size={15} /> Start Instant Party</>}
            </button>

            <div className="divider" style={{ margin: '4px 0' }}>
              <span>or join a friend&apos;s room</span>
            </div>

            <div className="join-row">
              <input
                type="text"
                maxLength={5}
                placeholder="CODE"
                autoComplete="off"
                spellCheck={false}
                aria-label="5-letter room code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                  setError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') joinParty(e);
                }}
                className="min-input code-input"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="min-btn ghost"
                style={{ minWidth: '112px' }}
                onClick={joinParty}
                disabled={loading !== '' || !code.trim()}
              >
                {loading === 'join' ? 'Joining…' : 'Join →'}
              </button>
            </div>
          </div>

          {error && <div className="min-error" role="alert">{error}</div>}

          {/* Account path — secondary */}
          <div className="divider" style={{ margin: '24px 0 14px' }}>
            <span>with an account</span>
          </div>
          <SignInButton mode="modal">
            <button type="button" className="min-btn ghost" style={{ width: '100%', fontSize: '13px' }}>
              Sign in for saved rooms &amp; host controls →
            </button>
          </SignInButton>
        </div>
      </div>

      {/* Features */}
      <section className="lp-section" id="features">
        <div className="lp-section-head">
          <p className="lp-section-eyebrow">Why ReelSync</p>
          <h2 className="lp-section-title">Built for movie nights, not meetings</h2>
          <p className="lp-section-desc">
            No uploads, no transcoding queue, no account required to get started — just a room code and a shared moment.
          </p>
        </div>
        <div className="lp-feature-grid">
          {features.map((f) => (
            <div className="lp-feature-card" key={f.title}>
              <div className="lp-feature-icon"><EmojiImg char={f.icon} size={20} /></div>
              <h3 className="lp-feature-title">{f.title}</h3>
              <p className="lp-feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-section-head">
          <p className="lp-section-eyebrow">How it works</p>
          <h2 className="lp-section-title">Up and running in three steps</h2>
        </div>
        <div className="lp-steps">
          <div className="lp-step">
            <span className="lp-step-num">1</span>
            <h3 className="lp-step-title">Start a party</h3>
            <p className="lp-step-desc">Enter your name and start an instant room — no sign-up needed.</p>
          </div>
          <div className="lp-step">
            <span className="lp-step-num">2</span>
            <h3 className="lp-step-title">Share the code</h3>
            <p className="lp-step-desc">Send your 5-letter room code to friends so they can join from any device.</p>
          </div>
          <div className="lp-step">
            <span className="lp-step-num">3</span>
            <h3 className="lp-step-title">Press play together</h3>
            <p className="lp-step-desc">Open the same file on each device and ReelSync keeps everyone in lockstep.</p>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        Peer-synchronized streaming. Local video files remain on your device.
      </footer>
    </main>
  );
}
