'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser, SignInButton } from '@clerk/nextjs';
import { getSocket, getSessionId } from '../lib/socket';
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
        sessionId: getSessionId(),
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
        sessionId: getSessionId(),
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
    { icon: '🔒', title: 'Files never leave your device', desc: 'Each person plays their own copy. Only play, pause and seek events travel over the wire.' },
    { icon: '⏱️', title: 'Everyone on the same frame', desc: 'Play, pause and seek hit every screen at once, and latecomers catch up to where the room is.' },
    { icon: '🎙️', title: 'Voice, chat & reactions', desc: 'Talk over the film, drop GIFs, or fire a 🍿 that floats across everyone’s screen.' },
    { icon: '🎞️', title: 'Subtitles & audio tracks', desc: 'Embedded MKV tracks, your own SRT/VTT/ASS files, and a room-wide timing nudge.' },
    { icon: '📺', title: 'A shared queue', desc: 'Search YouTube, movies and series, or paste a link — anyone in the room can add to it.' },
    { icon: '🚪', title: 'Private rooms', desc: 'Turn on knock-to-join and approve each guest before they get in.' },
  ];

  const steps = [
    { title: 'Start a room', desc: 'Type a name and hit start. No account needed.' },
    { title: 'Share the code', desc: 'Friends join from any browser with your 5-letter code.' },
    { title: 'Pick the same file', desc: 'Everyone opens their copy — playback locks together.' },
  ];

  const focusStart = () => {
    document.getElementById('start')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => nameInputRef.current?.focus({ preventScroll: true }), 350);
  };

  return (
    <main className="lp-page">
      <header className="lp-nav">
        <div className="minimal-brand">
          <span className="mb-icon">✦</span>
          <span>REELSYNC</span>
        </div>
        <div className="lp-nav-actions">
          <SignInButton mode="modal">
            <button type="button" className="min-btn ghost lp-nav-signin">Sign in</button>
          </SignInButton>
        </div>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-copy">
          <span className="lp-eyebrow-pill">✦ Synced streaming</span>
          <h1 className="hero-title lp-hero-title">
            Watch together<br />
            in <span className="hero-accent">lockstep</span>
          </h1>
          <p className="lp-hero-sub">
            Everyone opens their own copy of the same video. ReelSync keeps play, pause and seek in sync across every screen — your files never leave your device.
          </p>
          <ul className="lp-trust">
            <li>No uploads</li>
            <li>No sign-up to start</li>
            <li>Works on phone &amp; desktop</li>
          </ul>
        </div>

        <div className="lp-hero-card" id="start">
          <div className="minimal-card lp-start-card">
            <h2 className="lp-start-title">Start watching</h2>
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
                className="min-btn primary lp-start-cta"
                onClick={startInstantParty}
                disabled={loading !== ''}
              >
                {loading === 'instant' ? 'Starting…' : <><EmojiImg char="⚡" size={15} /> Start instant party</>}
              </button>

              <div className="divider lp-divider">
                <span>or join a room</span>
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
                />
                <button
                  type="button"
                  className="min-btn ghost"
                  onClick={joinParty}
                  disabled={loading !== '' || !code.trim()}
                >
                  {loading === 'join' ? 'Joining…' : 'Join'}
                </button>
              </div>
            </div>

            {error && <div className="min-error" role="alert">{error}</div>}

            <p className="lp-start-foot">
              Want saved rooms &amp; host controls?{' '}
              <SignInButton mode="modal">
                <button type="button" className="lp-link-btn">Sign in</button>
              </SignInButton>
            </p>
          </div>
        </div>
      </section>

      <section className="lp-preview" aria-hidden="true">
        <div className="lp-mock">
          <div className="lp-mock-bar">
            <span className="lp-mock-dot" /><span className="lp-mock-dot" /><span className="lp-mock-dot" />
            <span className="lp-mock-title">Friday Movie Night · <b>K7Q2M</b></span>
            <span className="lp-mock-live"><span className="live-dot" /> 4 watching</span>
          </div>
          <div className="lp-mock-body">
            <div className="lp-mock-player">
              <div className="lp-mock-screen">
                <span className="lp-mock-sub">“We’re going to need a bigger boat.”</span>
                <span className="lp-mock-float"><EmojiImg char="🍿" size={30} /></span>
                <span className="lp-mock-float f2"><EmojiImg char="😱" size={24} /></span>
              </div>
              <div className="lp-mock-transport">
                <span className="lp-mock-play" />
                <span className="lp-mock-track">
                  <span className="lp-mock-fill" />
                  <span className="lp-mock-tick" style={{ left: '46%', background: '#f59e0b' }} />
                  <span className="lp-mock-tick" style={{ left: '47%', background: '#60a5fa' }} />
                  <span className="lp-mock-tick" style={{ left: '47.5%', background: '#f472b6' }} />
                </span>
                <span className="lp-mock-time">1:02:14</span>
              </div>
            </div>
            <div className="lp-mock-chat">
              <div className="lp-mock-msg"><span className="lp-mock-av" style={{ background: '#f59e0b' }}>A</span><span><b>Asha</b>that shark is so fake <EmojiImg char="😂" size={13} /></span></div>
              <div className="lp-mock-msg"><span className="lp-mock-av" style={{ background: '#60a5fa' }}>R</span><span><b>Rohan</b>it’s 1975, respect it</span></div>
              <div className="lp-mock-msg"><span className="lp-mock-av" style={{ background: '#f472b6' }}>M</span><span><b>Mei</b>rewind to 58:10 pls</span></div>
              <div className="lp-mock-input">Say something…</div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="sources">
        <div className="lp-section-head">
          <p className="lp-section-eyebrow">Three ways to watch</p>
          <h2 className="lp-section-title">Bring a file, or just pick something</h2>
        </div>
        <div className="lp-sources">
          <article className="lp-source">
            <div className="lp-source-icon"><EmojiImg char="💾" size={22} /></div>
            <h3 className="lp-source-title">Your own files</h3>
            <p className="lp-source-desc">Everyone opens their copy of the same MP4, MKV or WebM. Full quality, and the video itself never touches our servers.</p>
            <ul className="lp-source-tags"><li>MP4 · MKV · WebM</li><li>Embedded subs</li><li>Audio tracks</li></ul>
          </article>
          <article className="lp-source">
            <div className="lp-source-icon"><EmojiImg char="🎬" size={22} /></div>
            <h3 className="lp-source-title">Movies &amp; series</h3>
            <p className="lp-source-desc">Search movies, series, anime and K-dramas and stream them together — no download. Browse seasons and jump to any episode.</p>
            <ul className="lp-source-tags"><li>Trending &amp; search</li><li>Episodes</li><li>Next-episode</li></ul>
            <p className="lp-source-note">
              <span aria-hidden="true">ⓘ</span>
              Streams come from third-party sources, so a title can occasionally be unavailable or slow to load. If one doesn’t play, try another server or title.
            </p>
          </article>
          <article className="lp-source">
            <div className="lp-source-icon"><EmojiImg char="▶️" size={22} /></div>
            <h3 className="lp-source-title">YouTube</h3>
            <p className="lp-source-desc">Search YouTube or paste any link. Trailers, music, podcasts — synced for the room, with captions and quality you pick.</p>
            <ul className="lp-source-tags"><li>Search or paste</li><li>Captions</li><li>Shared queue</li></ul>
          </article>
        </div>
      </section>

      <section className="lp-section" id="features">
        <div className="lp-section-head">
          <p className="lp-section-eyebrow">Why ReelSync</p>
          <h2 className="lp-section-title">Built for movie nights, not meetings</h2>
        </div>
        <div className="lp-feature-grid">
          {features.map((f) => (
            <div className="lp-feature-card" key={f.title}>
              <div className="lp-feature-icon"><EmojiImg char={f.icon} size={20} /></div>
              <div>
                <h3 className="lp-feature-title">{f.title}</h3>
                <p className="lp-feature-desc">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section lp-how">
        <div className="lp-section-head">
          <p className="lp-section-eyebrow">How it works</p>
          <h2 className="lp-section-title">Three steps to showtime</h2>
        </div>
        <ol className="lp-steps">
          {steps.map((s, i) => (
            <li className="lp-step" key={s.title}>
              <span className="lp-step-num">{i + 1}</span>
              <div>
                <h3 className="lp-step-title">{s.title}</h3>
                <p className="lp-step-desc">{s.desc}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-final">
        <h2 className="lp-final-title">Your next movie night starts with a code.</h2>
        <button type="button" className="min-btn primary" onClick={focusStart}>Start a party</button>
      </section>

      <footer className="lp-footer">
        Peer-synchronized streaming. Local video files stay on your device.
      </footer>
    </main>
  );
}
