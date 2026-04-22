'use client';

import { usePathname } from 'next/navigation';

const WORLD_PREFIXES = [
  '/settings/world',
  '/settings/members',
  '/settings/templates',
  '/settings/vault',
];

export function SettingsHeading(): React.JSX.Element {
  const pathname = usePathname() ?? '';
  const isWorld = WORLD_PREFIXES.some((p) => pathname.startsWith(p));

  const title = isWorld ? 'World settings' : 'Settings';
  const subtitle = isWorld
    ? 'Manage this world — members, templates, note imports, invite links.'
    : 'Change how you look and what you sign in with.';

  return (
    <>
      <h1
        className="mb-1 text-3xl font-bold"
        style={{ fontFamily: '"Fraunces", Georgia, serif' }}
      >
        {title}
      </h1>
      <p className="mb-6 text-sm text-[#5A4F42]">{subtitle}</p>
    </>
  );
}
