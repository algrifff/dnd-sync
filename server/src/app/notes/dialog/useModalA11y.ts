'use client';

// Shared focus-management hook for the app's hand-rolled modal dialogs
// (MoveDialog, CampaignDeleteDialog, TransferCharacterDialog, ConfirmDialog,
// PromptDialog, …). There is no focus-trap dependency in this repo — see
// server/package.json — so this is hand-rolled rather than adding one.
//
// None of these dialogs render through a portal; each mounts a
// `fixed inset-0` overlay wherever its trigger happens to live in the tree
// (a sidebar row, a menu, etc). That means we can't rely on a stable
// "everything outside the portal" boundary to make inert — instead we walk
// up from the dialog's own container to <body>, marking every *sibling*
// at each level `inert` + `aria-hidden`. That covers the rest of the page
// regardless of how deep the dialog happens to be nested.
//
// Usage: give the dialog's outermost (role="dialog") element a ref, call
// this hook with it once on mount (the component is only ever mounted
// while the dialog is open, so there's no separate "active" flag to
// thread through). Escape-to-close is intentionally NOT handled here —
// every call site already wires its own Escape listener (some gate it on
// a `submitting` flag) — this hook is focus management only.

import { useEffect } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => !el.hasAttribute('inert') && el.getClientRects().length > 0);
}

/** Marks every sibling of `target`, at every ancestor level up to (but
 *  excluding) `document.body`, as inert + aria-hidden. Returns a restore
 *  function that puts back whatever was there before. */
function makeOutsideInert(target: HTMLElement): () => void {
  const touched: Array<{
    el: Element;
    hadInert: boolean;
    hadAriaHidden: string | null;
  }> = [];
  let node: HTMLElement | null = target;
  while (node && node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (parent) {
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node) continue;
        touched.push({
          el: sibling,
          hadInert: sibling.hasAttribute('inert'),
          hadAriaHidden: sibling.getAttribute('aria-hidden'),
        });
        sibling.setAttribute('aria-hidden', 'true');
        sibling.setAttribute('inert', '');
      }
    }
    node = parent;
  }
  return () => {
    for (const { el, hadInert, hadAriaHidden } of touched) {
      if (!hadInert) el.removeAttribute('inert');
      if (hadAriaHidden === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', hadAriaHidden);
    }
  };
}

export function useModalA11y(
  containerRef: React.RefObject<HTMLElement | null>,
  initialFocusRef?: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const first = initialFocusRef?.current ?? getFocusable(container)[0];
    first?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const els = getFocusable(container);
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = els[0]!;
      const lastEl = els[els.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === firstEl || !container.contains(active)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (active === lastEl || !container.contains(active)) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    container.addEventListener('keydown', onKeyDown);

    const restoreInert = makeOutsideInert(container);

    return () => {
      container.removeEventListener('keydown', onKeyDown);
      restoreInert();
      // Restore focus to whatever triggered the dialog. Guard with
      // `isConnected` — the trigger row may have been removed from the
      // DOM by the very action the dialog just completed (e.g. the row
      // it lived on was deleted, or the app navigated away from it).
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
    // Deliberately empty: the owning component only ever mounts while the
    // dialog is open and unmounts on close, so mount/unmount IS the
    // active/inactive transition — there's nothing else to react to.
    // (containerRef/initialFocusRef are refs — stable identities, safe
    // to omit; this repo's eslint config has no exhaustive-deps rule to
    // silence.)
  }, []);
}
