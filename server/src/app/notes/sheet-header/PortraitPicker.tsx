'use client';

// Modal with two tabs: Upload a new file, or Pick one from the world's
// existing image assets. Emits a portrait value in our `asset:<id>`
// convention so the renderer resolves it through /api/assets/<id>.

import { useEffect, useState } from 'react';
import { X, Upload, Images } from 'lucide-react';
import { uploadImageAsset } from '@/lib/image-upload';

type AssetEntry = {
  id: string;
  mime: string;
  originalName: string;
  originalPath: string;
  tags: string[];
};

export function PortraitPicker({
  open,
  csrfToken,
  currentUrl,
  onClose,
  onPick,
}: {
  open: boolean;
  csrfToken: string;
  currentUrl: string | null;
  onClose: () => void;
  /** Called with the new portrait value (our `asset:<id>` format) or
   *  `null` to clear it. */
  onPick: (value: string | null) => void;
}): React.JSX.Element | null {
  const [tab, setTab] = useState<'upload' | 'pick'>('upload');
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open || tab !== 'pick') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    params.set('limit', '100');
    fetch(`/api/assets/list?${params.toString()}`, { credentials: 'include' })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          assets?: AssetEntry[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !body.ok) {
          setError(body.error ?? `failed (${res.status})`);
          setAssets([]);
        } else {
          setAssets(body.assets ?? []);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'network error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, q]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleUpload = async (file: File): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const stored = await uploadImageAsset(file, csrfToken);
      onPick(`asset:${stored.id}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[720px] rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-[var(--rule)] px-5 py-3">
          <div className="flex items-center gap-1">
            <TabButton active={tab === 'upload'} onClick={() => setTab('upload')} icon={<Upload size={14} />}>
              Upload
            </TabButton>
            <TabButton active={tab === 'pick'} onClick={() => setTab('pick')} icon={<Images size={14} />}>
              Pick from Assets
            </TabButton>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--ink-soft)] hover:bg-[var(--parchment-sunk)]"
          >
            <X size={16} />
          </button>
        </header>

        <div className="p-5">
          {error && (
            <div className="mb-3 rounded border border-[#B46353] bg-[#F4DAD2] px-3 py-2 text-sm text-[#5A1E12]">
              {error}
            </div>
          )}

          {tab === 'upload' ? (
            <UploadPane
              loading={loading}
              currentUrl={currentUrl}
              onFile={handleUpload}
              onClear={() => {
                onPick(null);
                onClose();
              }}
            />
          ) : (
            <PickPane
              loading={loading}
              assets={assets}
              q={q}
              setQ={setQ}
              onPick={(id) => {
                onPick(`asset:${id}`);
                onClose();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-sm ${
        active
          ? 'bg-[var(--ink)] text-[var(--vellum)]'
          : 'text-[var(--ink)] hover:bg-[var(--parchment-sunk)]'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function UploadPane({
  loading,
  currentUrl,
  onFile,
  onClear,
}: {
  loading: boolean;
  currentUrl: string | null;
  onFile: (f: File) => void;
  onClear: () => void;
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {currentUrl && (
        <div className="flex items-center gap-3">
          <img
            src={currentUrl}
            alt=""
            className="h-16 w-16 rounded-full border border-[var(--rule)] object-cover"
          />
          <div className="flex-1 text-sm text-[var(--ink-soft)]">Current portrait</div>
          <button
            type="button"
            onClick={onClear}
            className="rounded border border-[#B46353] bg-[var(--vellum)] px-3 py-1 text-sm text-[#B46353] hover:bg-[#F4DAD2]"
          >
            Clear
          </button>
        </div>
      )}

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
        className={`flex min-h-[180px] cursor-pointer flex-col items-center justify-center rounded-[12px] border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging
            ? 'border-[var(--ink)] bg-[var(--parchment)]'
            : 'border-[var(--rule)] bg-[var(--vellum)] hover:bg-[var(--parchment)]'
        }`}
      >
        <Upload size={28} className="mb-2 text-[var(--ink-soft)]" />
        <span className="text-sm font-semibold text-[var(--ink)]">
          {loading ? 'Uploading…' : 'Drop an image here, or click to pick a file'}
        </span>
        <span className="mt-1 text-xs text-[var(--ink-soft)]">PNG, JPEG, WebP, GIF or SVG</span>
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = '';
          }}
        />
      </label>
    </div>
  );
}

function PickPane({
  loading,
  assets,
  q,
  setQ,
  onPick,
}: {
  loading: boolean;
  assets: AssetEntry[];
  q: string;
  setQ: (v: string) => void;
  onPick: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name, path, or tag…"
        className="w-full rounded border border-[var(--rule)] bg-white px-3 py-1.5 text-sm outline-none focus:border-[var(--ink)]"
      />
      {loading && <p className="text-sm text-[var(--ink-soft)]">Loading…</p>}
      {!loading && assets.length === 0 && (
        <p className="text-sm italic text-[var(--ink-muted)]">
          No images match. Upload one in the other tab.
        </p>
      )}
      <div className="grid max-h-[420px] grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-5 md:grid-cols-6">
        {assets.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onPick(a.id)}
            title={a.originalPath}
            className="group relative overflow-hidden rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] hover:border-[var(--ink)]"
          >
            <img
              src={`/api/assets/${a.id}`}
              alt={a.originalName}
              loading="lazy"
              className="aspect-square h-auto w-full object-cover"
            />
            <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 py-0.5 text-[10px] text-white opacity-0 group-hover:opacity-100">
              {a.originalName}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
