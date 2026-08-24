import type { Metadata } from 'next';
import { Space_Grotesk, Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { NavBar } from '../components/nav-bar';
import { AuthProvider } from '../lib/auth-context';
import './globals.css';

const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-display',
});
const body = Inter({ subsets: ['latin'], variable: '--font-body' });

export const metadata: Metadata = {
  title: 'SeatSure — book the seat you actually want',
  description: 'High-concurrency event ticketing — zero overselling, proven under load.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-screen font-[family-name:var(--font-body)] text-slate-100 antialiased">
        <div className="app-backdrop" />
        <AuthProvider>
          <NavBar />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
