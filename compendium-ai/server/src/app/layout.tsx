// Root layout for the Next.js app. The admin/debug UI lives here later; for now
// it's just a plain shell so Tailwind's CSS is loaded.

import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Compendium',
  description: 'Real-time D&D vault',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
