'use client';

import { loginSchema, registerSchema } from '@seatsure/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth-context';

interface AuthFormProps {
  mode: 'login' | 'register';
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const { login, register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isLogin = mode === 'login';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const schema = isLogin ? loginSchema : registerSchema;
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid input');
      return;
    }

    setSubmitting(true);
    try {
      await (isLogin ? login : register)(parsed.data.email, parsed.data.password);
      router.push('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong, try again');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-[calc(100vh-64px)] flex-col items-center justify-center p-8">
      <form onSubmit={onSubmit} className="glass w-full max-w-sm space-y-4 rounded-2xl p-7" noValidate>
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold tracking-tight text-white">
          {isLogin ? 'Welcome back' : 'Create an account'}
        </h1>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-300">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-fuchsia-400 focus:outline-none"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-300">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            required
            minLength={isLogin ? 1 : 8}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-fuchsia-400 focus:outline-none"
          />
        </label>

        {error && <p className="text-sm text-rose-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-full bg-fuchsia-500 px-3 py-2.5 text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/30 transition-transform hover:scale-[1.02] hover:bg-fuchsia-400 disabled:opacity-50"
        >
          {submitting ? 'Please wait…' : isLogin ? 'Log in' : 'Register'}
        </button>

        <p className="text-sm text-slate-400">
          {isLogin ? (
            <>
              No account?{' '}
              <Link href="/register" className="font-medium text-fuchsia-300 underline underline-offset-4">
                Register
              </Link>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <Link href="/login" className="font-medium text-fuchsia-300 underline underline-offset-4">
                Log in
              </Link>
            </>
          )}
        </p>
      </form>
    </main>
  );
}
