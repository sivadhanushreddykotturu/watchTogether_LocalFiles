'use client';

import { io } from 'socket.io-client';

// One socket per browser tab, shared by every page.
// Same-origin by default; set NEXT_PUBLIC_SOCKET_URL when the frontend is
// deployed separately (e.g. Vercel frontend -> Render realtime).
let socket;

export function getSocket() {
  if (!socket) {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL || undefined;
    socket = io(url, { transports: ['websocket', 'polling'] }); // WS-first = faster connect
  }
  return socket;
}
