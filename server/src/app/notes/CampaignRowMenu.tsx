'use client';

// "…" menu rendered on campaign-root rows in the sidebar (Campaigns/<slug>).
// Single action: open the are-you-sure dialog and POST /api/campaigns/delete
// on confirm. World-owner-gated by the caller (FileTree).

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import { CampaignDeleteDialog } from './CampaignDeleteDialog';

export function CampaignRowMenu({
  slug,
  name,
  csrfToken,
  activePath,
}: {
  slug: string;
  name: string;
  csrfToken: string;
  activePath?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState<boolean>(false);
  const [dropUp, setDropUp] = useState<boolean>(false);
  const [showDelete, setShowDelete] = useState<boolean>(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const folderPath = `Campaigns/${slug}`;
  const activeIsAffected =
    activePath != null &&
    (activePath === folderPath || activePath.startsWith(folderPath + '/'));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (open) {
            setOpen(false);
          } else {
            if (ref.current) {
              const rect = ref.current.getBoundingClientRect();
              setDropUp(rect.bottom + 80 > window.innerHeight - 8);
            }
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Campaign actions"
        className="rounded-[4px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--ink)]/10 hover:text-[var(--ink)]"
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-30 w-48 overflow-hidden rounded-[8px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_8px_24px_rgb(var(--ink-rgb)/0.18)] ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setShowDelete(true);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--wine)] transition hover:bg-[var(--wine)]/10"
          >
            <Trash2 size={13} aria-hidden />
            <span>Delete campaign…</span>
          </button>
        </div>
      )}
      {showDelete && (
        <CampaignDeleteDialog
          slug={slug}
          name={name}
          csrfToken={csrfToken}
          onClose={() => setShowDelete(false)}
          onDeleted={() => {
            setShowDelete(false);
            if (activeIsAffected) {
              // Bounce out of the deleted note before the refresh.
              router.push('/');
            }
          }}
        />
      )}
    </div>
  );
}
