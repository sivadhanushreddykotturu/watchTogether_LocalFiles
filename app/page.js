'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser, SignInButton } from '@clerk/nextjs';
import { getSocket } from '../lib/socket';
import AuthButton from './components/AuthButton';

export default function Home() {
  const router = useRouter();
  const { user, isLoaded, isSignedIn } = useUser();
  const [activeTab, setActiveTab] = useState('discover'); // 'discover' | 'my-rooms' | 'create'
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [partyTitle, setPartyTitle] = useState('');
  const [isPrivateMode, setIsPrivateMode] = useState(false);
  const [myRooms, setMyRooms] = useState([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState('');
  const nameInputRef = useRef(null);

  useEffect(() => {
    // Pre-warm websocket connection immediately
    try {
      getSocket();
    } catch { /* ignore */ }

    if (user && (user.firstName || user.username)) {
      const displayName = user.firstName || user.username;
      setName(displayName);
      sessionStorage.setItem('reelsync:name', displayName);
    } else {
      const saved = sessionStorage.getItem('reelsync:name');
      if (saved) setName(saved);
    }

    const urlCode = new URLSearchParams(window.location.search).get('room');
    if (urlCode) {
      setCode(urlCode.toUpperCase().slice(0, 5));
    }
  }, [user]);

  // Load user's persistent rooms from database
  useEffect(() => {
    const fetchRooms = () => {
      const socket = getSocket();
      const ownerId = (user && user.id) || (typeof window !== 'undefined' && localStorage.getItem('reelsync:sessionId'));
      if (!ownerId || !socket) return;
      setLoadingRooms(true);
      socket.emit('get-my-rooms', { userId: user?.id, sessionId: ownerId }, (res) => {
        setLoadingRooms(false);
        if (res && Array.isArray(res.rooms)) {
          setMyRooms(res.rooms);
        }
      });
    };

    if (socketReady()) {
      fetchRooms();
    } else {
      const timer = setTimeout(fetchRooms, 600);
      return () => clearTimeout(timer);
    }
  }, [user, isSignedIn]);

  function socketReady() {
    try {
      return getSocket().connected;
    } catch {
      return false;
    }
  }

  function enter(res) {
    setLoading('');
    if (!res || res.error) {
      setError((res && res.error) || 'Something went wrong.');
      return;
    }
    sessionStorage.setItem('reelsync:name', res.self.name);
    router.push(`/room/${res.code}`);
  }

  const createParty = (customTitle = '', lockMode = false) => {
    setError('');
    const trimmedName = name.trim() || (user && (user.firstName || user.username)) || 'Host';
    setLoading('create');
    sessionStorage.setItem('reelsync:name', trimmedName);
    const ownerId = user?.id || (typeof window !== 'undefined' && localStorage.getItem('reelsync:sessionId'));
    
    getSocket().emit('create-room', {
      name: trimmedName,
      title: customTitle || partyTitle || `${trimmedName}'s Watch Party`,
      ownerId,
      controlLock: lockMode || isPrivateMode,
      sessionId: typeof window !== 'undefined' ? localStorage.getItem('reelsync:sessionId') : null,
    }, enter);
  };

  const joinParty = (targetCode = '') => {
    setError('');
    const joinCode = (targetCode || code).trim().toUpperCase();
    const trimmedName = name.trim() || (user && (user.firstName || user.username)) || 'Guest';

    if (!trimmedName) {
      setError('Please enter your name first.');
      if (nameInputRef.current) nameInputRef.current.focus();
      return;
    }
    if (!joinCode) {
      setError('Enter the 5-letter party code.');
      return;
    }
    setLoading('join');
    sessionStorage.setItem('reelsync:name', trimmedName);
    getSocket().emit('join-room', {
      code: joinCode,
      name: trimmedName,
      sessionId: typeof window !== 'undefined' ? localStorage.getItem('reelsync:sessionId') : null,
    }, enter);
  };

  return (
    <div className="dash-layout">
      {/* Top Navbar */}
      <header className="dash-nav">
        <div className="dash-nav-left">
          <span className="dash-logo">
            <span className="dash-logo-icon">🎬</span>
            <span className="dash-logo-text">REEL<span className="brand-accent">SYNC</span></span>
          </span>
          <nav className="dash-nav-links">
            <button
              type="button"
              className={'dash-nav-link' + (activeTab === 'discover' ? ' active' : '')}
              onClick={() => setActiveTab('discover')}
            >
              Watch Parties
            </button>
            {isSignedIn && (
              <button
                type="button"
                className={'dash-nav-link' + (activeTab === 'my-rooms' ? ' active' : '')}
                onClick={() => setActiveTab('my-rooms')}
              >
                My Rooms {myRooms.length > 0 && <span className="dash-count-pill">{myRooms.length}</span>}
              </button>
            )}
            <button
              type="button"
              className={'dash-nav-link' + (activeTab === 'create' ? ' active' : '')}
              onClick={() => setActiveTab('create')}
            >
              + Create Party
            </button>
          </nav>
        </div>

        <div className="dash-nav-right">
          <AuthButton />
        </div>
      </header>

      {/* Main Content Area */}
      <main className="dash-content">
        {/* Left Column: Hero & Featured Watch Parties */}
        <section className="dash-main-col">
          {/* Reference UI Panel #1: Hero Banner */}
          <div className="dash-hero-card">
            <div className="dash-hero-art-banner">
              <div className="dash-hero-poster poster-1" />
              <div className="dash-hero-poster poster-2" />
              <div className="dash-hero-overlay-glow" />
            </div>

            <div className="dash-hero-body">
              <div className="dash-live-badge-row">
                <span className="dash-live-pill">
                  <span className="live-pulse-dot" /> LIVE
                </span>
                <div className="dash-avatar-stack">
                  <span className="dash-stack-avatar bg-purple">🍿</span>
                  <span className="dash-stack-avatar bg-blue">🔥</span>
                  <span className="dash-stack-avatar bg-amber">🎬</span>
                  <span className="dash-stack-count">+420 watching</span>
                </div>
              </div>

              <h1 className="dash-hero-title">
                Watching movies <br />
                together is <span className="highlight-word">easy</span>
              </h1>
              <p className="dash-hero-desc">
                Everyone opens their copy or streams in perfect lockstep — play, pause, rewind — with real-time chat & reactions.
              </p>

              <div className="dash-hero-actions">
                <button
                  type="button"
                  className="dash-cta-btn"
                  onClick={() => createParty('Main Watch Party')}
                  disabled={loading !== ''}
                >
                  <span>{loading === 'create' ? 'Starting screening…' : 'Start Watching'}</span>
                  <span className="dash-cta-arrow">→</span>
                </button>
              </div>
            </div>
          </div>

          {/* Persistent Watch Parties Grid */}
          <div className="dash-section-head">
            <h2 className="dash-section-title">Watch Parties</h2>
            <div className="dash-section-sub">Jump into saved rooms or join friends</div>
          </div>

          <div className="dash-party-grid">
            {myRooms.length > 0 ? (
              myRooms.map((r) => (
                <div key={r.code} className="party-card" onClick={() => joinParty(r.code)}>
                  <div className="party-card-thumb">
                    <span className="party-thumb-icon">🎥</span>
                    {r.isLive && (
                      <span className="party-live-tag">
                        <span className="live-pulse-dot" /> {r.liveCount} online
                      </span>
                    )}
                  </div>
                  <div className="party-card-body">
                    <div className="party-card-title">{r.title}</div>
                    <div className="party-card-meta">
                      <span className="party-code-badge">ROOM {r.code}</span>
                      <span className="party-host-name">by {r.ownerName}</span>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <>
                {/* Default Sample Watch Parties */}
                <div className="party-card" onClick={() => createParty('Avengers: Endgame Party')}>
                  <div className="party-card-thumb avengers-thumb">
                    <span className="party-thumb-icon">⚡</span>
                    <span className="party-live-tag">
                      <span className="live-pulse-dot" /> Live
                    </span>
                  </div>
                  <div className="party-card-body">
                    <div className="party-card-title">Avengers: Endgame</div>
                    <div className="party-card-meta">
                      <span>Action, Sci-Fi • ★ 8.3</span>
                    </div>
                  </div>
                </div>

                <div className="party-card" onClick={() => createParty('Project: Adam Party')}>
                  <div className="party-card-thumb adam-thumb">
                    <span className="party-thumb-icon">🚀</span>
                    <span className="party-live-tag">
                      <span className="live-pulse-dot" /> 402 viewers
                    </span>
                  </div>
                  <div className="party-card-body">
                    <div className="party-card-title">Project: Adam</div>
                    <div className="party-card-meta">
                      <span>Action, Adventure • ★ 6.7</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Right Sidebar Column: Instant Join & Invitation (Reference UI #3) */}
        <aside className="dash-sidebar-col">
          {/* Card 1: Fast Join / Create */}
          <div className="dash-action-card">
            <h3 className="dash-action-title">
              <span>⚡</span> Quick Join or Create
            </h3>

            {code && (
              <div className="invite-banner" style={{ marginBottom: '12px' }}>
                Joining room <span className="invite-code">{code}</span>
              </div>
            )}

            <label className="dash-input-field">
              <span className="dash-input-label">Your Screen Name</span>
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
                className="dash-text-input"
              />
            </label>

            {activeTab === 'create' && (
              <>
                <label className="dash-input-field">
                  <span className="dash-input-label">Party Title</span>
                  <input
                    type="text"
                    maxLength={50}
                    placeholder="e.g. Friday Movie Night"
                    value={partyTitle}
                    onChange={(e) => setPartyTitle(e.target.value)}
                    className="dash-text-input"
                  />
                </label>

                <div className="dash-toggle-row">
                  <div>
                    <div className="dash-toggle-title">🔒 Host Approval Lobby</div>
                    <div className="dash-toggle-desc">Guests knock and wait for your approval</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={isPrivateMode}
                    onChange={(e) => setIsPrivateMode(e.target.checked)}
                    className="dash-checkbox"
                  />
                </div>
              </>
            )}

            <div className="dash-btn-group">
              <button
                type="button"
                className="btn primary big dash-main-btn"
                onClick={() => createParty()}
                disabled={loading !== ''}
              >
                {loading === 'create' ? 'Launching Room…' : '✦ Launch Watch Party'}
              </button>
            </div>

            <div className="divider"><span>or enter code</span></div>

            <div className="join-row">
              <input
                type="text"
                maxLength={5}
                placeholder="CODE"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                  setError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') joinParty();
                }}
              />
              <button
                type="button"
                className="btn primary"
                onClick={() => joinParty()}
                disabled={loading !== ''}
              >
                {loading === 'join' ? 'Joining…' : 'Join'}
              </button>
            </div>

            {error && <p className="error" role="alert">{error}</p>}
          </div>

          {/* Card 2: Reference UI Panel #3 - Private Party Invitation Card */}
          <div className="invitation-card">
            <div className="invite-top-meta">
              <span className="invite-tag">PRIVATE PARTY</span>
              <span className="invite-dot">•</span>
              <span className="invite-sender">Giorgi Kurasbediani</span>
            </div>

            <h4 className="invite-title">Party Invitation</h4>
            <div className="invite-time">TODAY AT 23:00</div>
            <p className="invite-msg">
              Hey! 👋 I&apos;d like to invite you to our horror movie night party.
            </p>

            <div className="invite-movie-preview">
              <span className="imp-thumb">🎬</span>
              <div className="imp-info">
                <div className="imp-title">Get Out</div>
                <div className="imp-meta">Horror • 2hr 4m • 2019</div>
              </div>
            </div>

            <div className="invite-members-row">
              <span className="im-label">Members</span>
              <div className="dash-avatar-stack">
                <span className="dash-stack-avatar bg-purple">👩</span>
                <span className="dash-stack-avatar bg-blue">👱‍♀️</span>
                <span className="dash-stack-avatar bg-amber">🧑</span>
                <span className="dash-stack-count">+11</span>
              </div>
            </div>

            <div className="invite-actions">
              <button
                type="button"
                className="btn ghost invite-reject-btn"
                onClick={() => setError('Invitation declined.')}
              >
                Reject
              </button>
              <button
                type="button"
                className="btn primary invite-accept-btn"
                onClick={() => createParty('Get Out Screening')}
              >
                Accept Invitation
              </button>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
