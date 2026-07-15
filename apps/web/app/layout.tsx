import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'SeatSure',
  description: 'High-concurrency event ticketing — zero overselling, proven under load.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900 antialiased">{children}</body>
    </html>
  );
}
