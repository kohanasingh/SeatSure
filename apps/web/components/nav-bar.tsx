'use client';

import Link from 'next/link';
import { useAuth } from '../lib/auth-context';

export function NavBar() {
  const { user, loading, logout } = useAuth();

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-black/40 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <Link
          href="/"
          className="font-[family-name:var(--font-display)] text-lg font-bold tracking-tight text-white"
        >
          Seat<span className="text-fuchsia-400">Sure</span>
        </Link>
        <nav className="flex items-center gap-5 text-sm">
          {loading ? null : user ? (
            <>
              <Link href="/bookings" className="font-medium text-slate-300 hover:text-white">
                My bookings
              </Link>
              <span className="hidden text-slate-500 sm:inline">{user.email}</span>
              <button
                type="button"
                onClick={() => void logout()}
                className="rounded-full border border-white/15 px-3.5 py-1.5 font-medium text-slate-200 hover:bg-white/5"
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="font-medium text-slate-300 hover:text-white">
                Log in
              </Link>
              <Link
                href="/register"
                className="rounded-full bg-fuchsia-500 px-4 py-1.5 font-semibold text-white shadow-md shadow-fuchsia-500/30 hover:bg-fuchsia-400"
              >
                Register
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
