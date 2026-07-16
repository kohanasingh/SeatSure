const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Access token lives in module memory only (never localStorage — XSS cannot
// exfiltrate what is not persisted). Lost on reload; restored via the httpOnly
// refresh cookie by AuthProvider's silent refresh.
let accessToken: string | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};

export interface AuthUser {
  id: string;
  email: string;
  role: 'USER' | 'ORGANIZER' | 'ADMIN';
}

export interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include', // carry the refresh cookie on /auth/* calls
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });
}

/** Calls /auth/refresh using the httpOnly cookie; returns the session or null. */
export async function silentRefresh(): Promise<AuthResponse | null> {
  const res = await rawFetch('/auth/refresh', { method: 'POST' });
  if (!res.ok) return null;
  const data = (await res.json()) as AuthResponse;
  setAccessToken(data.accessToken);
  return data;
}

/**
 * Authenticated fetch: on a 401 (expired access token) it silently refreshes
 * once and retries the original request.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await rawFetch(path, init);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    const refreshed = await silentRefresh();
    if (refreshed) res = await rawFetch(path, init);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, body?.message ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
