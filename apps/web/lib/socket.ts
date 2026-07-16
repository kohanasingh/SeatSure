'use client';

import { Socket, io } from 'socket.io-client';
import { getAccessToken } from './api';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

let socket: Socket | null = null;

/**
 * Lazy singleton. The auth callback runs on every (re)connection attempt, so
 * a reconnect after login/logout picks up the current in-memory token — a
 * valid token joins the user:<id> room server-side.
 */
export function getSocket(): Socket {
  socket ??= io(API_URL, {
    auth: (cb) => cb({ token: getAccessToken() ?? undefined }),
  });
  return socket;
}

/** Force a new handshake so the socket's identity matches the session. */
export function refreshSocketAuth(): void {
  if (socket?.connected) {
    socket.disconnect();
    socket.connect();
  }
}
