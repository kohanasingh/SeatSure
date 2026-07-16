'use client';

import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ApiError,
  AuthResponse,
  AuthUser,
  apiFetch,
  setAccessToken,
  silentRefresh,
} from './api';

interface AuthContextValue {
  user: AuthUser | null;
  /** true until the initial silent refresh has settled */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the session after a full page load: the access token lives only in
  // memory, so we trade the refresh cookie for a fresh one.
  useEffect(() => {
    silentRefresh()
      .then((session) => setUser(session?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const authenticate = useCallback(async (path: string, email: string, password: string) => {
    const data = await apiFetch<AuthResponse>(path, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setAccessToken(data.accessToken);
    setUser(data.user);
  }, []);

  const login = useCallback(
    (email: string, password: string) => authenticate('/auth/login', email, password),
    [authenticate],
  );
  const register = useCallback(
    (email: string, password: string) => authenticate('/auth/register', email, password),
    [authenticate],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch<void>('/auth/logout', { method: 'POST' });
    } catch (err) {
      // 401/network on logout is fine — we drop the session locally regardless
      if (!(err instanceof ApiError)) throw err;
    } finally {
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
