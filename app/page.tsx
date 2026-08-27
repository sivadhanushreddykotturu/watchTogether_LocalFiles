'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import { getSocket } from '../lib/socket';
import AuthButton from './components/AuthButton';
import { UserRoom } from '../types/realtime';

export default function Home(): React.JSX.Element {
  const router = useRouter();
  const { user, isLoaded, isSignedIn } = useUser();
  const [tab, setTab] = useState<'create' | 'join' | 'rooms'>('create');
  const [name, setName] = useState<string>('');
  const [code, setCode] = useState<string>('');
  const [partyTitle, setPartyTitle] = useState<string>('');
  const [isPrivateMode, setIsPrivateMode] = useState<boolean>(false);
  const [myRooms, setMyRooms] = useState<UserRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState<string>('');
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      getSocket();
    } catch {
      /* ignore */
    }

    if (user && (user.firstName || user.username)) {
      const displayName = user.firstName || user.username || '';
      setName(displayName);
      sessionStorage.setItem('reelsync:name', displayName);
    } else {
      const saved = sessionStorage.getItem('reelsync:name');
      if (saved) setName(saved);
    }

    const urlCode = new URLSearchParams(window.location.search).get('room');
    if (urlCode) {
      setCode(urlCode.toUpperCase().slice(0, 5));
      setTab('join');
    }
  }, [user]);

  // Load user's persistent rooms from database
  useEffect(() => {
    const fetchRooms = () => {
      const socket = getSocket();
      const ownerId =
        (user && user.id) ||
        (typeof window !== 'undefined' && localStorage.getItem('reelsync:sessionId'));
      if (!ownerId || !socket || !socket.connected) return;
      setLoadingRooms(true);
      socket.emit(
        'get-my-rooms',
        { userId: user?.id, sessionId: ownerId },
        (res: { rooms?: UserRoom[] }) => {
          setLoadingRooms(false);
          if (res && Array.isArray(res.rooms)) {
            setMyRooms(res.rooms);
          }
        }
      );
    };

    const timer = setTimeout(fetchRooms, 400);
    return () => clearTimeout(timer);
  }, [user, isSignedIn, tab]);

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

  const createParty = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError('');
    const trimmedName =
      name.trim() || (user && (user.firstName || user.username)) || 'Host';

    if (!trimmedName) {
      setError('Please enter your name first.');
      if (nameInputRef.current) nameInputRef.current.focus();
      return;
    }

    setLoading('create');
    sessionStorage.setItem('reelsync:name', trimmedName);
    const ownerId =
      user?.id ||
      (typeof window !== 'undefined' && localStorage.getItem('reelsync:sessionId'));

    getSocket().emit(
      'create-room',
      {
        name: trimmedName,
        title: partyTitle.trim() || `${trimmedName}'s Watch Party`,
        ownerId,
        controlLock: isPrivateMode,
        sessionId:
          typeof window !== 'undefined' ? localStorage.getItem('reelsync:sessionId') : null,
      },
      enter
    );
  };

  const joinParty = (e?: React.FormEvent, targetCode = '') => {
    if (e) e.preventDefault();
    setError('');
    const joinCode = (targetCode || code).trim().toUpperCase();
    const trimmedName =
      name.trim() || (user && (user.firstName || user.username)) || 'Guest';

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
    getSocket().emit(
      'join-room',
      {
        code: joinCode,
        name: trimmedName,
        sessionId:
          typeof window !== 'undefined' ? localStorage.getItem('reelsync:sessionId') : null,
      },
      enter
    );
  };

  return (
    <main className="minimal-landing">
      {/* Top Bar */}
      <header className="minimal-header">
        <div className="minimal-brand">
          <span className="mb-icon">✦</span>
          <span className="mb-text">REELSYNC</span>
        </div>
        <div className="minimal-auth">
          <AuthButton />
        </div>
      </header>

      {/* Centered Hub Card */}
      <div className="minimal-card">
        {/* Title and Subtitle */}
        <div className="minimal-hero">
          <h1 className="minimal-title">Synced Cinema</h1>
          <p className="minimal-desc">
            Watch local files, YouTube, and streams together with zero desync.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="minimal-tabs">
          <button
            type="button"
            className={'min-tab' + (tab === 'create' ? ' active' : '')}
            onClick={() => {
              setTab('create');
              setError('');
            }}
          >
            Create Party
          </button>
          <button
            type="button"
            className={'min-tab' + (tab === 'join' ? ' active' : '')}
            onClick={() => {
              setTab('join');
              setError('');
            }}
          >
            Join with Code
          </button>
          <button
            type="button"
            className={'min-tab' + (tab === 'rooms' ? ' active' : '')}
            onClick={() => {
              setTab('rooms');
              setError('');
            }}
          >
            My Rooms {myRooms.length > 0 && <span className="tab-pill">{myRooms.length}</span>}
          </button>
        </div>

        {/* Tab 1: Create Watch Party */}
        {tab === 'create' && (
          <form onSubmit={createParty} className="minimal-form">
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
              <label className="min-label">Room Title (Optional)</label>
              <input
                type="text"
                maxLength={60}
                placeholder="e.g. Movie Night"
                value={partyTitle}
                onChange={(e) => setPartyTitle(e.target.value)}
                className="min-input"
              />
            </div>

            <div className="min-toggle-box" onClick={() => setIsPrivateMode(!isPrivateMode)}>
              <div className="mtb-info">
                <span className="mtb-title">{isPrivateMode ? '🔒 Private Room (Host Approval)' : '🔓 Open Room'}</span>
                <span className="mtb-sub">
                  {isPrivateMode ? 'Guests must knock and be accepted by host' : 'Anyone with the 5-letter code joins instantly'}
                </span>
              </div>
              <div className={'min-switch' + (isPrivateMode ? ' on' : '')}>
                <div className="switch-dot" />
              </div>
            </div>

            <button
              type="submit"
              className="min-btn primary"
              disabled={loading !== ''}
            >
              {loading === 'create' ? 'Starting screening…' : 'Start Watch Party →'}
            </button>
          </form>
        )}

        {/* Tab 2: Join with Code */}
        {tab === 'join' && (
          <form onSubmit={(e) => joinParty(e)} className="minimal-form">
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
              <label className="min-label">Room Code</label>
              <input
                type="text"
                maxLength={5}
                placeholder="ABCDE"
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

            <button
              type="submit"
              className="min-btn primary"
              disabled={loading !== ''}
            >
              {loading === 'join' ? 'Joining room…' : 'Join Party →'}
            </button>
          </form>
        )}

        {/* Tab 3: My Persistent Rooms */}
        {tab === 'rooms' && (
          <div className="minimal-rooms-list">
            {myRooms.length > 0 ? (
              myRooms.map((r) => (
                <div key={r.code} className="min-room-row" onClick={() => joinParty(undefined, r.code)}>
                  <div className="mrr-left">
                    <span className="mrr-icon">🎬</span>
                    <div>
                      <div className="mrr-title">{r.title}</div>
                      <div className="mrr-meta">
                        <span className="mrr-code">{r.code}</span>
                        {r.isLive && <span className="mrr-live">● {r.liveCount} online</span>}
                      </div>
                    </div>
                  </div>
                  <button type="button" className="min-btn small">
                    Jump in →
                  </button>
                </div>
              ))
            ) : (
              <div className="min-empty-rooms">
                <span className="mer-icon">🍿</span>
                <p>No saved rooms yet</p>
                <button
                  type="button"
                  className="min-btn ghost"
                  style={{ marginTop: '8px', fontSize: '12px' }}
                  onClick={() => setTab('create')}
                >
                  + Create your first party
                </button>
              </div>
            )}
          </div>
        )}

        {error && <p className="min-error" role="alert">{error}</p>}
      </div>

      <footer className="minimal-footer">
        Peer-synchronized streaming. Local files remain on your device.
      </footer>
    </main>
  );
}
