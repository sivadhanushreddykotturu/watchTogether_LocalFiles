'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser, UserButton } from '@clerk/nextjs';
import { getSocket } from '../../lib/socket';
import { UserRoom } from '../../types/realtime';
import { ThemeToggle } from '../components/ThemeToggle';

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
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

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
      <main className="minimal-landing" style={{ justifyContent: 'center' }}>
        <div className="min-empty-rooms" style={{ maxWidth: '360px', margin: '0 auto' }}>
          <div className="tgp-spinner" style={{ margin: '0 auto 16px' }} />
          <p style={{ margin: 0, fontWeight: 500 }}>Opening your dashboard…</p>
        </div>
      </main>
    );
  }

  const displayName = user.firstName || user.username || 'Member';

  return (
    <main className="minimal-landing" style={{ justifyContent: 'flex-start' }}>
      {/* Top Navigation Bar */}
      <header className="minimal-header">
        <div className="minimal-brand" style={{ cursor: 'pointer' }} onClick={() => router.push('/dashboard')}>
          <span className="mb-icon">✦</span>
          <span>REELSYNC</span>
          <span className="tab-pill" style={{ marginLeft: '4px' }}>DASHBOARD</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <ThemeToggle />
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '4px' }}>
            <UserButton />
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--theme-text)' }}>
              {displayName}
            </span>
          </div>
        </div>
      </header>

      {/* Main Dashboard Card */}
      <div className="minimal-card">
        <div style={{ marginBottom: '24px' }}>
          <h1 className="minimal-title" style={{ textAlign: 'left', margin: '0 0 6px' }}>
            My Watch Parties
          </h1>
          <p className="minimal-desc" style={{ textAlign: 'left' }}>
            Persistent cinema rooms saved to your account. Stay synced with friends anytime.
          </p>
        </div>

        {/* Section 1: Create Room Form */}
        <form onSubmit={createPersistentRoom} className="minimal-form" style={{ marginBottom: '28px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px' }}>
            <input
              type="text"
              maxLength={60}
              placeholder="Party Title (e.g. Movie Night, Anime Club)"
              value={partyTitle}
              onChange={(e) => setPartyTitle(e.target.value)}
              className="min-input"
            />
            <button type="submit" className="min-btn primary" disabled={loading !== ''} style={{ width: 'auto', minWidth: '140px' }}>
              {loading === 'create' ? 'Creating…' : '+ Create Party'}
            </button>
          </div>

          {/* Privacy Toggle Box */}
          <div
            className="min-toggle-box"
            onClick={() => setIsPrivateMode(!isPrivateMode)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                setIsPrivateMode(!isPrivateMode);
              }
            }}
          >
            <div className="mtb-info">
              <div className="mtb-title">
                <span>{isPrivateMode ? '🔒 Private Party (Knock to Join)' : '🔓 Open Party (Direct Access)'}</span>
              </div>
              <div className="mtb-sub">
                {isPrivateMode
                  ? 'Guests request permission and must be approved by the host'
                  : 'Anyone with the room link can join and stream directly'}
              </div>
            </div>
            <div className={'min-switch' + (isPrivateMode ? ' on' : '')}>
              <div className="switch-dot" />
            </div>
          </div>
        </form>

        {/* Section 2: Saved Persistent Rooms */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--theme-text-dim)' }}>
            Saved Rooms ({myRooms.length})
          </span>
          {myRooms.length > 0 && (
            <button
              type="button"
              onClick={fetchRooms}
              className="copy-chip-btn"
              title="Refresh rooms"
            >
              🔄 Refresh
            </button>
          )}
        </div>

        <div className="minimal-rooms-list" style={{ marginBottom: '28px' }}>
          {loadingRooms ? (
            <div className="min-empty-rooms" style={{ padding: '24px 16px' }}>
              <p style={{ margin: 0 }}>Loading your saved rooms…</p>
            </div>
          ) : myRooms.length > 0 ? (
            myRooms.map((r) => (
              <div key={r.code} className="min-room-row">
                <div className="mrr-left" onClick={() => joinExistingRoom(undefined, r.code)} style={{ flex: 1 }}>
                  <div className="mrr-icon">🎬</div>
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
                    onClick={(e) => copyRoomLink(r.code, e)}
                    title="Copy room link"
                  >
                    {copiedCode === r.code ? '✓ Copied' : '🔗 Link'}
                  </button>
                  <button
                    type="button"
                    className="min-btn small"
                    style={{ background: 'var(--accent)', color: '#FFFFFF', borderColor: 'transparent' }}
                    onClick={() => joinExistingRoom(undefined, r.code)}
                  >
                    Join Room →
                  </button>
                  <button
                    type="button"
                    className="min-btn ghost"
                    style={{ padding: '7px 10px', fontSize: '13px', color: 'var(--error)' }}
                    onClick={() => deleteRoom(r.code)}
                    title="Delete room"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="min-empty-rooms">
              <span className="mer-icon">🍿</span>
              <p style={{ margin: '0 0 4px', fontWeight: 600, color: 'var(--theme-text)' }}>
                No watch parties yet
              </p>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--theme-text-muted)' }}>
                Create a persistent party above or join a friend&apos;s code below.
              </p>
            </div>
          )}
        </div>

        {/* Section 3: Join Room with Code */}
        <div className="divider" style={{ margin: '24px 0 20px' }}>
          <span>or join with friend&apos;s code</span>
        </div>

        <form onSubmit={(e) => joinExistingRoom(e)} className="join-row">
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
          <button
            type="submit"
            className="min-btn primary"
            disabled={loading !== '' || !joinCode.trim()}
            style={{ width: 'auto', minWidth: '120px' }}
          >
            {loading === 'join' ? 'Joining…' : 'Join Party'}
          </button>
        </form>

        {error && <div className="min-error" role="alert">{error}</div>}
      </div>

      <footer className="minimal-footer">
        Signed in as <strong style={{ color: 'var(--theme-text)' }}>{displayName}</strong>. Rooms are synced in real-time.
      </footer>
    </main>
  );
}
