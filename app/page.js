'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSocket } from '../lib/socket';

export default function Landing() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const saved = sessionStorage.getItem('reelsync:name');
    if (saved) setName(saved);
    const urlCode = new URLSearchParams(window.location.search).get('room');
    if (urlCode) setCode(urlCode.toUpperCase().slice(0, 5));
  }, []);

  function enter(res) {
    if (!res || res.error) {
      setError((res && res.error) || 'Something went wrong.');
      return;
    }
    sessionStorage.setItem('reelsync:name', res.self.name);
    router.push(`/room/${res.code}`);
  }

  const create = () => {
    setError('');
    getSocket().emit('create-room', name, enter);
  };

  const join = () => {
    setError('');
    if (!code.trim()) { setError('Enter the 5-letter room code.'); return; }
    getSocket().emit('join-room', { code, name }, enter);
  };

  const onEnterKey = (e) => { if (e.key === 'Enter') join(); };

  return (
    <main className="landing">
      <div className="landing-card">
        <p className="eyebrow">Synced local cinema</p>
        <h1 className="wordmark"><span className="stroke">REEL</span><span className="fill-word">SYNC</span></h1>
        <p className="tagline">Everyone opens their own copy of the file. ReelSync keeps every screen in lockstep — play, pause, rewind — with chat on the side.</p>

        <label className="field">
          <span className="field-label">Your name</span>
          <input
            type="text"
            maxLength={24}
            placeholder="e.g. Maya"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onEnterKey}
          />
        </label>

        <button className="btn primary big" onClick={create}>Start a screening</button>

        <div className="divider"><span>or join one</span></div>

        <div className="join-row">
          <input
            type="text"
            maxLength={5}
            placeholder="CODE"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={onEnterKey}
          />
          <button className="btn primary" onClick={join}>Join room</button>
        </div>

        <p className="error" role="alert">{error}</p>
      </div>
      <footer className="landing-foot">Nothing is uploaded — files stay on each machine.</footer>
    </main>
  );
}
