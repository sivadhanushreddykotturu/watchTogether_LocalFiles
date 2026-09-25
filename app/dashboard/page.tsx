'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser, useAuth, UserButton } from '@clerk/nextjs';
import { getSocket } from '../../lib/socket';
import { UserRoom } from '../../types/realtime';
import { ThemeToggle } from '../components/ThemeToggle';
import { EmojiImg } from '../components/AppleEmoji';

export default function DashboardPage(): React.JSX.Element {
  const router = useRouter();
  const { user, isLoaded, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const [partyTitle, setPartyTitle] = useState<string>('');
  const [isPrivateMode, setIsPrivateMode] = useState<boolean>(false);
  const [myRooms, setMyRooms] = useState<UserRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = useState<boolean>(true);
  const [joinCode, setJoinCode] = useState<string>('');
  const [loading, setLoading] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace('/');
    }
  }, [isLoaded, isSignedIn, router]);

  const fetchRooms = async () => {
    if (!user?.id) return;
    const socket = getSocket();
    setLoadingRooms(true);
    // Ownership is proven with a session token, never a claimed id.
    const authToken = await getToken();
    socket.emit('get-my-rooms', { authToken }, (res: { rooms?: UserRoom[] }) => {
      setLoadingRooms(false);
      if (res && Array.isArray(res.rooms)) {
        setMyRooms(res.rooms);
      }
    });
  };

  useEffect(() => {
    if (user?.id) {
      sessionStorage.setItem('reelsync:name', user.firstName || user.username || 'Host');
      fetchRooms();
    }
  }, [user]);

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

  const createPersistentRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const displayName = user?.firstName || user?.username || 'Host';
    const title = partyTitle.trim() || `${displayName}'s Watch Party`;
    setLoading('create');

    sessionStorage.setItem('reelsync:name', displayName);

    getSocket().emit(
      'create-room',
      {
        name: displayName,
        title,
        authToken: await getToken(),
        controlLock: isPrivateMode,
        sessionId: typeof window !== 'undefined' ? localStorage.getItem('reelsync:sessionId') : null,
      },
      enter
    );
  };

  const joinExistingRoom = (e?: React.FormEvent, codeToJoin = '') => {
    if (e) e.preventDefault();
    setError('');
    const code = (codeToJoin || joinCode).trim().toUpperCase();
    if (!code) {
      setError('Please enter the 5-letter room code.');
      return;
    }

    const displayName = user?.firstName || user?.username || 'Member';
    setLoading('join');
    sessionStorage.setItem('reelsync:name', displayName);

    getSocket().emit(
      'join-room',
      {
        code,
        name: displayName,
        sessionId: typeof window !== 'undefined' ? localStorage.getItem('reelsync:sessionId') : null,
      },
      enter
    );
  };

  const deleteRoom = async (code: string) => {
    if (!user?.id) return;
    if (!confirm(`Are you sure you want to delete room ${code}?`)) return;

    const authToken = await getToken();
    getSocket().emit('delete-room', { code, authToken }, (res: { success?: boolean; error?: string }) => {
      if (res?.success) {
        setMyRooms((prev) => prev.filter((r) => r.code !== code));
      } else if (res?.error) {
        setError(res.error);
      }
    });
  };

  const copyRoomLink = (code: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${window.location.origin}/room/${code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    });
  };

  if (!isLoaded || !isSignedIn) {
    return (
      <main className="minimal-landing">
        <div className="min-empty-rooms" style={{ maxWidth: '360px', margin: '0 auto' }}>
          <div className="tgp-spinner" style={{ margin: '0 auto 16px' }} />
          <p style={{ margin: 0, fontWeight: 500 }}>Opening your dashboard…</p>
        </div>
      </main>
    );
  }

  const displayName = user.firstName || user.username || 'Member';
  const liveRooms = myRooms.filter((r) => r.isLive);
  const watchingNow = liveRooms.reduce((sum, r) => sum + (r.liveCount || 0), 0);

  return (
    <div className="app-shell">
      <header className="lp-nav app-nav">
        <button type="button" className="minimal-brand brand-btn" onClick={() => router.push('/dashboard')}>
          <span className="mb-icon">✦</span>
          <span>REELSYNC</span>
        </button>
        <div className="lp-nav-actions">
          <ThemeToggle />
          <div className="app-nav-user">
            <UserButton />
            <span className="app-nav-name">{displayName}</span>
          </div>
        </div>
      </header>

      <main className="dash">
        <section className="dash-hero">
          <div>
            <p className="dash-eyebrow">Dashboard</p>
            <h1 className="dash-title">Hey {displayName}</h1>
            <p className="dash-sub">Your saved rooms stay put between sessions — share the code once, reuse it every movie night.</p>
          </div>
          <dl className="dash-stats">
            <div className="dash-stat">
              <dt>Saved rooms</dt>
              <dd>{loadingRooms ? '–' : myRooms.length}</dd>
            </div>
            <div className="dash-stat">
              <dt>Live now</dt>
              <dd className={liveRooms.length ? 'is-live' : ''}>{loadingRooms ? '–' : liveRooms.length}</dd>
            </div>
            <div className="dash-stat">
              <dt>Watching</dt>
              <dd>{loadingRooms ? '–' : watchingNow}</dd>
            </div>
          </dl>
        </section>

        {error && <div className="min-error dash-error" role="alert">{error}</div>}

        <div className={'dash-grid' + (!loadingRooms && myRooms.length > 0 ? ' has-rooms' : '')}>
          <aside className="dash-actions">
            <form onSubmit={createPersistentRoom} className="dash-card">
              <h2 className="dash-card-title">Start a party</h2>
              <p className="dash-card-sub">Creates a room saved to your account.</p>
              <input
                type="text"
                maxLength={60}
                placeholder="Title, e.g. Friday Movie Night"
                aria-label="Party title"
                value={partyTitle}
                onChange={(e) => setPartyTitle(e.target.value)}
                className="min-input"
              />
              <button
                type="button"
                className="dash-toggle"
                role="switch"
                aria-checked={isPrivateMode}
                onClick={() => setIsPrivateMode(!isPrivateMode)}
              >
                <span className="dash-toggle-text">
                  <span className="dash-toggle-title">
                    <EmojiImg char={isPrivateMode ? '🔒' : '🔓'} size={13} />
                    {isPrivateMode ? 'Private — knock to join' : 'Open — anyone with the link'}
                  </span>
                  <span className="dash-toggle-sub">
                    {isPrivateMode ? 'You approve each guest before they get in.' : 'Guests with the code join instantly.'}
                  </span>
                </span>
                <span className={'min-switch' + (isPrivateMode ? ' on' : '')} aria-hidden="true">
                  <span className="switch-dot" />
                </span>
              </button>
              <button type="submit" className="min-btn primary dash-card-cta" disabled={loading !== ''}>
                {loading === 'create' ? 'Creating…' : 'Create party'}
              </button>
            </form>

            <form onSubmit={(e) => joinExistingRoom(e)} className="dash-card">
              <h2 className="dash-card-title">Join with a code</h2>
              <div className="join-row">
                <input
                  type="text"
                  maxLength={5}
                  placeholder="CODE"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="5-letter room code"
                  value={joinCode}
                  onChange={(e) => {
                    setJoinCode(e.target.value.toUpperCase());
                    setError('');
                  }}
                  className="min-input code-input"
                />
                <button type="submit" className="min-btn ghost" disabled={loading !== '' || !joinCode.trim()}>
                  {loading === 'join' ? 'Joining…' : 'Join'}
                </button>
              </div>
            </form>
          </aside>

          <section className="dash-rooms" aria-labelledby="rooms-heading">
            <div className="dash-section-head">
              <h2 id="rooms-heading" className="dash-section-title">Your rooms</h2>
              {myRooms.length > 0 && (
                <button type="button" onClick={fetchRooms} className="dash-refresh" title="Refresh rooms">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
                  Refresh
                </button>
              )}
            </div>

            {loadingRooms ? (
              <div className="room-grid" aria-busy="true">
                {[0, 1, 2, 3].map((i) => <div key={i} className="room-card skeleton" />)}
              </div>
            ) : myRooms.length > 0 ? (
              <div className="room-grid">
                {myRooms.map((r) => (
                  <article key={r.code} className={'room-card' + (r.isLive ? ' live' : '')}>
                    <button
                      type="button"
                      className="room-card-main"
                      onClick={() => joinExistingRoom(undefined, r.code)}
                      title={`Join ${r.title}`}
                    >
                      <span className="room-card-art" aria-hidden="true">
                        <span className="room-card-initial">{(r.title || '?').trim()[0]?.toUpperCase()}</span>
                      </span>
                      <span className="room-card-body">
                        <span className="room-card-title">{r.title}</span>
                        <span className="room-card-meta">
                          <span className="mrr-code">{r.code}</span>
                          {r.isLive ? (
                            <span className="room-card-status live"><span className="live-dot" />{r.liveCount} watching</span>
                          ) : (
                            <span className="room-card-status">Idle</span>
                          )}
                        </span>
                      </span>
                    </button>
                    <div className="room-card-actions">
                      <button type="button" className="min-btn primary small-cta" onClick={() => joinExistingRoom(undefined, r.code)}>
                        {r.isLive ? 'Join now' : 'Open'}
                      </button>
                      <button
                        type="button"
                        className="icon-action"
                        onClick={(e) => copyRoomLink(r.code, e)}
                        title="Copy invite link"
                        aria-label="Copy invite link"
                      >
                        {copiedCode === r.code ? (
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        )}
                      </button>
                      <button
                        type="button"
                        className="icon-action danger"
                        onClick={() => deleteRoom(r.code)}
                        title="Delete room"
                        aria-label="Delete room"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="dash-empty">
                <EmojiImg char="🍿" size={32} />
                <p className="dash-empty-title">No saved rooms yet</p>
                <p className="dash-empty-sub">Start a party and it&apos;ll show up here, ready for next time.</p>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
