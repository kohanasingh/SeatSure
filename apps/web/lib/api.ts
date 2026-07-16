const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Access token lives in module memory only (never localStorage — XSS cannot
// exfiltrate what is not persisted). Lost on reload; restored via the httpOnly
// refresh cookie by AuthProvider's silent refresh.
let accessToken: string | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};

export const getAccessToken = (): string | null => accessToken;

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
    const body = (await res.json().catch(() => null)) as {
      message?: string;
      error?: { message?: string }; // tRPC error envelope
    } | null;
    throw new ApiError(
      res.status,
      body?.message ?? body?.error?.message ?? `Request failed (${res.status})`,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

interface TrpcEnvelope<T> {
  result?: { data: T };
  error?: { message: string };
}

/**
 * Authenticated tRPC calls from the browser (mutations and user-scoped
 * queries) — goes through apiFetch so the silent-refresh-on-401 applies.
 * The public SSR reads use the typed client in lib/trpc.ts instead.
 */
export async function trpcMutate<T>(
  procedure: string,
  input: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const envelope = await apiFetch<TrpcEnvelope<T>>(`/trpc/${procedure}`, {
    method: 'POST',
    body: JSON.stringify(input),
    headers,
  }).catch((err: unknown) => {
    throw err instanceof ApiError ? err : new ApiError(0, 'Network error');
  });
  if (envelope.error || !envelope.result) {
    throw new ApiError(400, envelope.error?.message ?? 'Request failed');
  }
  return envelope.result.data;
}

export async function trpcQuery<T>(procedure: string, input: unknown): Promise<T> {
  const encoded = encodeURIComponent(JSON.stringify(input));
  const envelope = await apiFetch<TrpcEnvelope<T>>(`/trpc/${procedure}?input=${encoded}`);
  if (envelope.error || !envelope.result) {
    throw new ApiError(400, envelope.error?.message ?? 'Request failed');
  }
  return envelope.result.data;
}
