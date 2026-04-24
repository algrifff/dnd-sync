import type { Metadata } from 'next';
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

const APP_URL = process.env.APP_URL ?? 'https://pit-pals.com';

const DESCRIPTION =
  'The best TTRPG note-taking app. Real-time collaborative notes, character sheets, session logs, and AI assistance — purpose-built for tabletop campaigns.';

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: 'Pit Pals — TTRPG Note-Taking App',
    template: '%s — Pit Pals',
  },
  description: DESCRIPTION,
  keywords: [
    'TTRPG',
    'tabletop RPG',
    'DnD notes',
    'campaign notes',
    'character sheets',
    'game master tools',
    'RPG note taking',
    'collaborative notes',
    'session logs',
  ],
  openGraph: {
    type: 'website',
    siteName: 'Pit Pals',
    title: 'Pit Pals — TTRPG Note-Taking App',
    description: DESCRIPTION,
    images: [{ url: '/og-image.png', width: 1254, height: 1254, alt: 'Pit Pals' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pit Pals — TTRPG Note-Taking App',
    description: DESCRIPTION,
    images: ['/og-image.png'],
  },
  robots: {
    index: true,
    follow: false,
  },
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
