'use client';

import Link from 'next/link';
import { useAuth } from '../lib/auth-context';

export function NavBar() {
  const { user, loading, logout } = useAuth();

  return (
    <header className="flex items-center justify-between border-b border-gray-200 px-6 py-3">
      <Link href="/" className="text-lg font-bold tracking-tight">
        SeatSure
      </Link>
      <nav className="flex items-center gap-4 text-sm">
        {loading ? null : user ? (
          <>
            <span className="text-gray-600">{user.email}</span>
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-md border border-gray-300 px-3 py-1.5 font-medium hover:bg-gray-50"
            >
              Log out
            </button>
          </>
        ) : (
          <>
            <Link href="/login" className="font-medium hover:underline">
              Log in
            </Link>
            <Link
              href="/register"
              className="rounded-md bg-gray-900 px-3 py-1.5 font-medium text-white hover:bg-gray-700"
            >
              Register
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
