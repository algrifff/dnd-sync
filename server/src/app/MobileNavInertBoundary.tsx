'use client';

// Wraps the main app shell (header, file tree, note content) so it can
// be marked `inert` while the mobile nav drawer is open — screen
// readers and keyboard Tab both skip an inert subtree entirely, so the
// page behind the drawer stops being reachable without needing a
// manual aria-hidden + tabindex sweep of every descendant.
//
// This is just the existing outermost ContentLayout div with a ref
// bolted on — pass the same className it already had so the flex
// layout is untouched.

import { useEffect, useRef, type ReactNode } from 'react';
import { useMobileNav } from './MobileNavContext';

export function MobileNavInertBoundary({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  const nav = useMobileNav();
  const ref = useRef<HTMLDivElement | null>(null);
  const open = nav?.open ?? false;

  useEffect(() => {
    if (ref.current) ref.current.inert = open;
  }, [open]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
