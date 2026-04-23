// Root layout — loads Fraunces (display) + Inter (body) via next/font,
// applies the parchment background, and sets the default title.

import type { ReactElement, ReactNode } from 'react';
import { Fraunces, Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const fraunces = Fraunces({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-fraunces',
  axes: ['SOFT', 'WONK'],
});

export const metadata = {
  title: 'Pit Pals',
  description: 'Live-edited shared TTRPG vault',
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
      <body
        className="antialiased"
        style={{
          fontFamily:
            'var(--font-inter), -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
        }}
      >
        {children}
      </body>
    </html>
  );
}
