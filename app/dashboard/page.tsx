'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser, UserButton } from '@clerk/nextjs';
import { getSocket } from '../../lib/socket';
import { UserRoom } from '../../types/realtime';

export default function DashboardPage(): React.JSX.Element {
  const router = useRouter();
  const { user, isLoaded, isSignedIn } = useUser();
  const [partyTitle, setPartyTitle] = useState<string>('');
  const [isPrivateMode, setIsPrivateMode] = useState<boolean>(false);
  const [myRooms, setMyRooms] = useState<UserRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = useState<boolean>(true);
  const [joinCode, setJoinCode] = useState<string>('');
  const [loading, setLoading] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace('/');
    }
  }, [isLoaded, isSignedIn, router]);

  const fetchRooms = () => {
    if (!user?.id) return;
    const socket = getSocket();
    setLoadingRooms(true);
    socket.emit('get-my-rooms', { userId: user.id }, (res: { rooms?: UserRoom[] }) => {
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

  const createPersistentRoom = (e: React.FormEvent) => {
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
        ownerId: user?.id,
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

  const deleteRoom = (code: string) => {
    if (!user?.id) return;
    if (!confirm(`Are you sure you want to delete room ${code}?`)) return;

    getSocket().emit('delete-room', { code, ownerId: user.id }, (res: { success?: boolean }) => {
      if (res?.success) {
        setMyRooms((prev) => prev.filter((r) => r.code !== code));
      }
    });
  };

  if (!isLoaded || !isSignedIn) {
    return (
      <main className="minimal-landing" style={{ justifyContent: 'center' }}>
        <div className="min-empty-rooms">
          <div className="tgp-spinner" style={{ margin: '0 auto 16px' }} />
          <p>Loading dashboard…</p>
        </div>
      </main>
    );
  }

  const displayName = user.firstName || user.username || 'Member';

  return (
    <main className="minimal-landing" style={{ justifyContent: 'flex-start', minHeight: '100vh' }}>
      {/* Top Navbar */}
      <header className="minimal-header" style={{ maxWidth: '780px', marginBottom: '20px' }}>
        <div className="minimal-brand" style={{ cursor: 'pointer' }} onClick={() => router.push('/dashboard')}>
          <span className="mb-icon">✦</span>
          <span className="mb-text">REELSYNC</span>
          <span className="tab-pill" style={{ marginLeft: '6px' }}>DASHBOARD</span>
        </div>
        <div className="minimal-auth" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <UserButton />
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#FFFFFF' }}>{displayName}</span>
        </div>
      </header>

      {/* Main Dashboard Hub */}
      <div className="minimal-card" style={{ maxWidth: '780px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div>
            <h1 className="minimal-title" style={{ textAlign: 'left', margin: '0 0 4px' }}>
              My Watch Parties
            </h1>
            <p className="minimal-desc" style={{ textAlign: 'left' }}>
              Persistent rooms that stay available until you delete them.
            </p>
          </div>
        </div>

        {/* Section 1: Create Persistent Party Form */}
        <form onSubmit={createPersistentRoom} className="minimal-form" style={{ marginBottom: '28px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: '12px' }}>
            <input
              type="text"
              maxLength={60}
              placeholder="Party Title (e.g. Weekend Cinema)"
              value={partyTitle}
              onChange={(e) => setPartyTitle(e.target.value)}
              className="min-input"
            />
            <button type="submit" className="min-btn primary" disabled={loading !== ''}>
              {loading === 'create' ? 'Launching…' : '+ Create Party'}
            </button>
          </div>

          <div className="min-toggle-box" onClick={() => setIsPrivateMode(!isPrivateMode)} style={{ marginTop: '2px' }}>
            <div className="mtb-info">
              <span className="mtb-title">
                {isPrivateMode ? '🔒 Private Room (Host Knock Approval)' : '🔓 Open Room'}
              </span>
              <span className="mtb-sub">
                {isPrivateMode ? 'Guests must request and be approved to enter' : 'Anyone with link joins directly'}
              </span>
            </div>
            <div className={'min-switch' + (isPrivateMode ? ' on' : '')}>
              <div className="switch-dot" />
            </div>
          </div>
        </form>

        {/* Section 2: Persistent Rooms List */}
        <div className="dash-section-head" style={{ marginBottom: '12px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#71717A' }}>
            Saved Rooms ({myRooms.length})
          </span>
        </div>

        <div className="minimal-rooms-list" style={{ marginBottom: '28px' }}>
          {loadingRooms ? (
            <div className="min-empty-rooms">
              <p>Loading your saved rooms…</p>
            </div>
          ) : myRooms.length > 0 ? (
            myRooms.map((r) => (
              <div key={r.code} className="min-room-row">
                <div className="mrr-left" onClick={() => joinExistingRoom(undefined, r.code)} style={{ flex: 1 }}>
                  <span className="mrr-icon">🎬</span>
                  <div>
                    <div className="mrr-title">{r.title}</div>
                    <div className="mrr-meta">
                      <span className="mrr-code">{r.code}</span>
                      {r.isLive ? (
                        <span className="mrr-live">● {r.liveCount} online</span>
                      ) : (
                        <span>Ready</span>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    type="button"
                    className="min-btn small"
                    onClick={() => joinExistingRoom(undefined, r.code)}
                  >
                    Join Room →
                  </button>
                  <button
                    type="button"
                    className="min-btn ghost"
                    style={{ padding: '6px 10px', fontSize: '12px', color: '#EF4444' }}
                    onClick={() => deleteRoom(r.code)}
                    title="Delete persistent room"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="min-empty-rooms" style={{ padding: '24px 16px' }}>
              <span className="mer-icon">🍿</span>
              <p>You haven&apos;t created any persistent watch parties yet.</p>
            </div>
          )}
        </div>

        {/* Section 3: Join Friend's Room with Code */}
        <div className="divider" style={{ margin: '20px 0' }}>
          <span>or enter a friend&apos;s code</span>
        </div>

        <form onSubmit={(e) => joinExistingRoom(e)} className="join-row" style={{ marginTop: '12px' }}>
          <input
            type="text"
            maxLength={5}
            placeholder="CODE"
            autoComplete="off"
            spellCheck={false}
            value={joinCode}
            onChange={(e) => {
              setJoinCode(e.target.value.toUpperCase());
              setError('');
            }}
            className="min-input code-input"
            style={{ flex: 1 }}
          />
          <button type="submit" className="min-btn primary" disabled={loading !== '' || !joinCode.trim()}>
            {loading === 'join' ? 'Joining…' : 'Join'}
          </button>
        </form>

        {error && <p className="min-error" role="alert">{error}</p>}
      </div>

      <footer className="minimal-footer">
        Signed in as {displayName}. Persistent rooms are saved to your account.
      </footer>
    </main>
  );
}
