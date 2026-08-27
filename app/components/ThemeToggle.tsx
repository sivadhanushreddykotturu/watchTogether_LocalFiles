'use client';

import React, { useEffect, useState } from 'react';

export function ThemeToggle({ className = '' }: { className?: string }): React.JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [mounted, setMounted] = useState<boolean>(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem('reelsync:theme') as 'light' | 'dark' | null;
    if (saved === 'light' || saved === 'dark') {
      setTheme(saved);
      document.documentElement.setAttribute('data-theme', saved);
    } else {
      const current = document.documentElement.getAttribute('data-theme') as 'light' | 'dark' | null;
      if (current) {
        setTheme(current);
      }
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('reelsync:theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };

  if (!mounted) {
    return (
      <div className={`theme-toggle-container ${className}`}>
        <button type="button" className="theme-toggle-btn" aria-label="Toggle theme">
          <span>🌙 Dark</span>
        </button>
      </div>
    );
  }

  return (
    <div className={`theme-toggle-container ${className}`}>
      <button
        type="button"
        className="theme-toggle-btn"
        onClick={toggleTheme}
        title={`Switch to ${theme === 'dark' ? 'Minimal White & Gray' : 'Dark'} mode`}
        aria-label="Toggle theme"
      >
        {theme === 'dark' ? (
          <>
            <span style={{ fontSize: '13px' }}>🌙</span>
            <span>Dark</span>
          </>
        ) : (
          <>
            <span style={{ fontSize: '13px' }}>☀️</span>
            <span>Minimal White</span>
          </>
        )}
      </button>
    </div>
  );
}

export default ThemeToggle;
