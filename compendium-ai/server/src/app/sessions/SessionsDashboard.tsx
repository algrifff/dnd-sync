'use client';

// Sessions dashboard. Groups the flat sessions list by campaign and
// renders each campaign as a card with its entries in reverse
// chronological order. DMs get a "+ New" affordance per campaign
// that opens a small dialog (date, optional title + session number)
// and posts to /api/sessions/create.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarDays, Plus, UsersRound, X } from 'lucide-react';

type SessionEntry = {
  notePath: string;
  campaignSlug: string | null;
  sessionDate: string | null;
  sessionNumber: number | null;
  title: string | null;
  attendees: string[];
};

type Campaign = { slug: string; name: string };

export function SessionsDashboard({
  csrfToken,
  canCreate,
  campaigns,
  sessions,
}: {
  csrfToken: string;
  canCreate: boolean;
  campaigns: Campaign[];
  sessions: SessionEntry[];
}): React.JSX.Element {
  const [openFor, setOpenFor] = useState<string | null>(null);

  const sessionsByCampaign = useMemo(() => {
    const out: Record<string, SessionEntry[]> = {};
    for (const s of sessions) {
      const key = s.campaignSlug ?? '';
      (out[key] ??= []).push(s);
    }
    return out;
  }, [sessions]);

  if (campaigns.length === 0 && sessions.length === 0) {
    return (
      <p className="rounded-[10px] border border-dashed border-[#D4C7AE] bg-[#FBF5E8]/60 px-4 py-6 text-sm text-[#5A4F42]">
        No campaigns detected yet — any note saved under
        <code className="mx-1">Campaigns/&lt;name&gt;/</code> will create one
        automatically.
      </p>
    );
  }

  const slugs = new Set(campaigns.map((c) => c.slug));
  const ordered = [
    ...campaigns,
    // Show an "unassigned" bucket if any session is orphan.
    ...Object.keys(sessionsByCampaign)
      .filter((k) => k !== '' && !slugs.has(k))
      .map((k) => ({ slug: k, name: k })),
  ];
  const hasOrphans = !!sessionsByCampaign[''];

  return (
    <div className="space-y-6">
      {openFor && (
        <NewSessionDialog
          csrfToken={csrfToken}
          campaign={
            campaigns.find((c) => c.slug === openFor) ?? {
              slug: openFor,
              name: openFor,
            }
          }
          onClose={() => setOpenFor(null)}
        />
      )}
      {ordered.map((c) => {
        const rows = sessionsByCampaign[c.slug] ?? [];
        return (
          <section
            key={c.slug}
            className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-4"
          >
            <div className="mb-2 flex items-center gap-2">
              <h2 className="flex-1 text-base font-semibold text-[#2A241E]">
                {c.name}
              </h2>
              {canCreate && (
                <button
                  type="button"
                  onClick={() => setOpenFor(c.slug)}
                  className="flex items-center gap-1 rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1 text-xs font-medium text-[#2A241E] transition hover:bg-[#EAE1CF]"
                >
                  <Plus size={12} aria-hidden /> New
                </button>
              )}
            </div>
            {rows.length === 0 ? (
              <p className="text-xs text-[#5A4F42]">No sessions yet.</p>
            ) : (
              <ul className="divide-y divide-[#D4C7AE]/50">
                {rows.map((s) => (
                  <SessionRow key={s.notePath} session={s} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {hasOrphans && (
        <section className="rounded-[12px] border border-dashed border-[#D4C7AE] bg-[#FBF5E8]/60 p-4">
          <h2 className="mb-2 text-sm font-semibold text-[#5A4F42]">
            Sessions with no campaign
          </h2>
          <ul className="divide-y divide-[#D4C7AE]/50">
            {sessionsByCampaign['']!.map((s) => (
              <SessionRow key={s.notePath} session={s} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SessionRow({
  session,
}: {
  session: SessionEntry;
}): React.JSX.Element {
  const label =
    session.title ??
    (session.sessionNumber != null ? `Session ${session.sessionNumber}` : 'Session');
  return (
    <li>
      <Link
        href={`/notes/${session.notePath
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`}
        className="flex items-center gap-3 px-1 py-2 transition hover:bg-[#F4EDE0]/70"
      >
        <div className="flex min-w-[84px] items-center gap-1 text-xs text-[#5A4F42]">
          <CalendarDays size={12} aria-hidden />
          {session.sessionDate ?? '—'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[#2A241E]">
            {session.sessionNumber != null && (
              <span className="mr-1 text-[#5A4F42]">
                #{session.sessionNumber}
              </span>
            )}
            {label}
          </div>
        </div>
        {session.attendees.length > 0 && (
          <div
            className="flex shrink-0 items-center gap-1 text-xs text-[#5A4F42]"
            title={session.attendees.join(', ')}
          >
            <UsersRound size={12} aria-hidden />
            {session.attendees.length}
          </div>
        )}
      </Link>
    </li>
  );
}

function NewSessionDialog({
  csrfToken,
  campaign,
  onClose,
}: {
  csrfToken: string;
  campaign: Campaign;
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const [date, setDate] = useState<string>(() => formatToday());
  const [title, setTitle] = useState<string>('');
  const [sessionNumber, setSessionNumber] = useState<string>('');
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        campaignSlug: campaign.slug,
        date,
      };
      if (title.trim()) body.title = title.trim();
      if (sessionNumber.trim() !== '') {
        const n = Number(sessionNumber);
        if (Number.isFinite(n) && n > 0) body.sessionNumber = Math.trunc(n);
      }
      const res = await fetch('/api/sessions/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(body),
      });
      const respBody = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        path?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !respBody.ok || !respBody.path) {
        setError(
          respBody.detail ?? respBody.error ?? `create failed (${res.status})`,
        );
        return;
      }
      router.push(
        '/notes/' + respBody.path.split('/').map(encodeURIComponent).join('/'),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#2A241E]/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-4 shadow-[0_16px_48px_rgba(42,36,30,0.25)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#2A241E]">
            New session — {campaign.name}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[6px] p-1 text-[#5A4F42] transition hover:bg-[#F4EDE0]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-[#5A4F42]">
            Date
          </span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1.5 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-[#5A4F42]">
            Title (optional)
          </span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. The Hired Help"
            className="w-full rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1.5 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-[#5A4F42]">
            Session # (optional)
          </span>
          <input
            type="number"
            min={1}
            value={sessionNumber}
            onChange={(e) => setSessionNumber(e.target.value)}
            className="w-full rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1.5 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
          />
        </label>

        {error && <p className="mb-3 text-xs text-[#8B4A52]">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] px-3 py-1.5 text-xs font-medium text-[#5A4F42] transition hover:text-[#2A241E]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !date}
            className="rounded-[6px] bg-[#2A241E] px-3 py-1.5 text-xs font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-50"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

function formatToday(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
