'use client';

import { useUser, SignInButton, UserButton } from '@clerk/nextjs';

export default function AuthButton() {
  const { isSignedIn, user, isLoaded } = useUser();

  if (!isLoaded) return null;

  if (isSignedIn) {
    return (
      <div className="auth-btn-wrap" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <UserButton afterSignOutUrl="/" />
        <span className="auth-name" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}>
          {user.firstName || user.username || 'Member'}
        </span>
      </div>
    );
  }

  return (
    <SignInButton mode="modal">
      <button className="btn ghost" style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '8px' }}>
        Sign in
      </button>
    </SignInButton>
  );
}
