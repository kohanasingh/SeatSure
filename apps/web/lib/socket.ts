'use client';

import { Socket, io } from 'socket.io-client';
import { getAccessToken } from './api';

// empty string = same origin (prod: nginx proxies /socket.io/ to the API)
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

let socket: Socket | null = null;

/**
 * Lazy singleton. The auth callback runs on every (re)connection attempt, so
 * a reconnect after login/logout picks up the current in-memory token — a
 * valid token joins the user:<id> room server-side.
 */
export function getSocket(): Socket {
  const options = {
    auth: (cb: (data: object) => void) => cb({ token: getAccessToken() ?? undefined }),
  };
  socket ??= API_URL ? io(API_URL, options) : io(options);
  return socket;
}

/** Force a new handshake so the socket's identity matches the session. */
export function refreshSocketAuth(): void {
  if (socket?.connected) {
    socket.disconnect();
    socket.connect();
  }
}
