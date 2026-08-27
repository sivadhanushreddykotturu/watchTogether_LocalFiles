'use client';

import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;
let watchdogInterval: NodeJS.Timeout | null = null;
let serverClockOffsetMs = 0;

export function getSocket(): Socket {
  if (typeof window === 'undefined') {
    // Server-side fallback dummy
    return {} as Socket;
  }

  if (!socket) {
    socket = io({
      transports: ['websocket', 'polling'], // WS-first for 0ms connection time
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 3500,
      randomizationFactor: 0.3,
      timeout: 10000,
    });

    socket.on('connect', () => {
      // Re-calculate clock offset immediately on connect
      syncServerClock();
    });

    // Watchdog to ensure socket never hangs in a half-open state on mobile sleep/wake
    if (!watchdogInterval) {
      watchdogInterval = setInterval(() => {
        if (socket && !socket.connected && !socket.active) {
          try {
            socket.connect();
          } catch {
            /* ignore */
          }
        }
      }, 5000);
    }
  }

  return socket;
}

export function syncServerClock(): void {
  const sock = getSocket();
  if (!sock || !sock.connected) return;

  const t0 = Date.now();
  sock.emit('ntp-sync', t0, ({ t1, t2 }: { t1: number; t2: number } = { t1: 0, t2: 0 }) => {
    if (!t1 || !t2) return;
    const t3 = Date.now();
    // Offset = ((t2 - t0) + (t2 - t3)) / 2
    serverClockOffsetMs = Math.round((t2 - t0 + (t2 - t3)) / 2);
  });
}

export function getServerTime(): number {
  return Date.now() + serverClockOffsetMs;
}

export function getClockOffset(): number {
  return serverClockOffsetMs;
}
