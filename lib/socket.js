'use client';

import { io } from 'socket.io-client';

// One socket per browser tab, shared by every page. Same-origin:
// the custom server serves both the pages and the realtime.
let socket;

export function getSocket() {
  if (!socket) {
    socket = io({ transports: ['websocket', 'polling'] }); // WS-first = faster connect
  }
  return socket;
}
