'use client';

// Shared open/close state for the mobile navigation drawer (world
// switcher + file tree), so the hamburger button in AppHeader and the
// drawer it opens — which live in different components — can agree on
// state without prop-drilling through the server-component layouts.
//
// Scoped to `(content)/layout.tsx`, not the outer `(app)/layout.tsx` —
// see MobileNavDrawer.tsx for why that's sufficient. Pages rendered
// outside this provider (currently: the settings layout, which has its
// own hand-rolled sidebar and hasn't been given a drawer yet) simply
// get no mobile-nav button: `useMobileNav()` returns null there instead
// of throwing, so AppHeader keeps rendering normally on those pages.

import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

type MobileNavContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The hamburger trigger button. Focus is restored here when the
   *  drawer closes (Escape, backdrop click, or navigating away). */
  triggerRef: RefObject<HTMLButtonElement | null>;
};

const MobileNavContext = createContext<MobileNavContextValue | null>(null);

export function MobileNavProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <MobileNavContext.Provider value={{ open, setOpen, triggerRef }}>
      {children}
    </MobileNavContext.Provider>
  );
}

/** Returns null when rendered outside a MobileNavProvider rather than
 *  throwing — see the module comment above for why that matters. */
export function useMobileNav(): MobileNavContextValue | null {
  return useContext(MobileNavContext);
}
