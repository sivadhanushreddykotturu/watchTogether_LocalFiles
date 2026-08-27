'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import { getSocket } from '../lib/socket';
import AuthButton from './components/AuthButton';

export default function Landing() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState('');
  const nameInputRef = useRef(null);

  useEffect(() => {
    // Pre-warm websocket connection immediately on page load
    try {
      getSocket();
    } catch { /* ignore */ }

    if (user && (user.firstName || user.username)) {
      setName(user.firstName || user.username);
    } else {
      const saved = sessionStorage.getItem('reelsync:name');
      if (saved) setName(saved);
    }
    const urlCode = new URLSearchParams(window.location.search).get('room');
    if (urlCode) {
      setCode(urlCode.toUpperCase().slice(0, 5));
    }
    if (nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [user]);

  function enter(res) {
    setLoading('');
    if (!res || res.error) {
      setError((res && res.error) || 'Something went wrong.');
      return;
    }
    sessionStorage.setItem('reelsync:name', res.self.name);
    router.push(`/room/${res.code}`);
  }

  const create = () => {
    setError('');
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Please enter your name first.');
      if (nameInputRef.current) nameInputRef.current.focus();
      return;
    }
    setLoading('create');
    sessionStorage.setItem('reelsync:name', trimmedName);
    getSocket().emit('create-room', trimmedName, enter);
  };

  const join = () => {
    setError('');
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Please enter your name to join.');
      if (nameInputRef.current) nameInputRef.current.focus();
      return;
    }
    if (!code.trim()) {
      setError('Enter the 5-letter room code.');
      return;
    }
    setLoading('join');
    sessionStorage.setItem('reelsync:name', trimmedName);
    getSocket().emit('join-room', { code: code.trim().toUpperCase(), name: trimmedName }, enter);
  };

  const onEnterKey = (e) => {
    if (e.key === 'Enter') {
      if (code.trim()) join();
      else create();
    }
  };

  return (
    <main className="landing">
      <div className="landing-card">
        {/* Auth button — top right */}
        <div className="landing-top-bar">
          <span className="landing-brand">REEL<span className="brand-accent">SYNC</span></span>
          <AuthButton />
        </div>

        <div className="landing-hero">
          <p className="eyebrow">Synced local cinema</p>
          <h1 className="wordmark"><span className="stroke">REEL</span><span className="fill-word">SYNC</span></h1>
          <p className="tagline">Watch movies together — everyone opens their own copy. ReelSync keeps every screen in lockstep.</p>
        </div>

        {code && (
          <div className="invite-banner">
            Joining room <span className="invite-code">{code}</span>
          </div>
        )}

        <div className="landing-form">
          <label className="field">
            <span className="field-label">Your name</span>
            <input
              ref={nameInputRef}
              type="text"
              maxLength={24}
              placeholder="e.g. Dhanush"
              autoComplete="off"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              onKeyDown={onEnterKey}
            />
          </label>

          <button className="btn primary big" onClick={create} disabled={loading !== ''}>
            {loading === 'create' ? 'Starting screening…' : '✦ Start a screening'}
          </button>

          <div className="divider"><span>or join one</span></div>

          <div className="join-row">
            <input
              type="text"
              maxLength={5}
              placeholder="CODE"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(''); }}
              onKeyDown={onEnterKey}
            />
            <button className="btn primary" onClick={join} disabled={loading !== ''}>
              {loading === 'join' ? 'Joining…' : 'Join'}
            </button>
          </div>

          {error && <p className="error" role="alert">{error}</p>}
        </div>

        <footer className="landing-foot">Nothing is uploaded — files stay on each machine.</footer>
      </div>
    </main>
  );
}
