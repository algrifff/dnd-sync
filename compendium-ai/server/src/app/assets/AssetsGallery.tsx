'use client';

// Assets gallery — image-first grid with folder-derived bucket
// filters and a full-size preview modal.
//
// Buckets are derived from the segment after the nearest Assets/
// folder in the path (typical vault convention). Non-image mimes
// (PDFs, videos, audio) fall into an "Other" bucket rendered as a
// text-only list; they're still clickable.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { FileText, X } from 'lucide-react';

type Asset = {
  id: string;
  mime: string;
  size: number;
  originalName: string;
  originalPath: string;
  uploadedAt: number;
};

export function AssetsGallery({
  assets,
}: {
  assets: Asset[];
}): React.JSX.Element {
  const buckets = useMemo(() => bucketize(assets), [assets]);
  const bucketNames = Object.keys(buckets).sort(bucketSort);
  const [activeBucket, setActiveBucket] = useState<string>(
    bucketNames[0] ?? 'All',
  );
  const [preview, setPreview] = useState<Asset | null>(null);

  if (assets.length === 0) {
    return (
      <p className="rounded-[10px] border border-dashed border-[#D4C7AE] bg-[#FBF5E8]/60 px-4 py-6 text-sm text-[#5A4F42]">
        No assets yet. Upload a vault ZIP from{' '}
        <Link href="/settings/vault" className="underline">
          /settings/vault
        </Link>{' '}
        to populate the gallery.
      </p>
    );
  }

  const active = buckets[activeBucket] ?? [];

  return (
    <div>
      {/* Bucket chips */}
      <div className="mb-4 flex flex-wrap items-center gap-1">
        {bucketNames.map((name) => {
          const selected = name === activeBucket;
          const count = buckets[name]!.length;
          return (
            <button
              key={name}
              type="button"
              onClick={() => setActiveBucket(name)}
              aria-pressed={selected}
              className={
                'flex items-center gap-1 rounded-[8px] border px-2.5 py-1 text-xs font-medium transition ' +
                (selected
                  ? 'border-[#2A241E] bg-[#2A241E] text-[#F4EDE0]'
                  : 'border-[#D4C7AE] bg-[#F4EDE0] text-[#2A241E] hover:bg-[#EAE1CF]')
              }
            >
              {name}
              <span
                className={
                  'rounded-full px-1.5 text-[10px] ' +
                  (selected ? 'bg-[#F4EDE0]/20' : 'bg-[#EAE1CF]')
                }
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Grid */}
      {activeBucket === 'Other' ? (
        <ul className="divide-y divide-[#D4C7AE]/50 overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8]">
          {active.map((a) => (
            <li key={a.id}>
              <a
                href={`/api/assets/${encodeURIComponent(a.id)}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 px-3 py-2 transition hover:bg-[#F4EDE0]"
              >
                <FileText size={14} aria-hidden className="shrink-0 text-[#5A4F42]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[#2A241E]">
                    {a.originalName}
                  </div>
                  <div className="truncate text-xs text-[#5A4F42]">
                    {a.originalPath}
                  </div>
                </div>
                <div className="shrink-0 text-xs text-[#5A4F42]">
                  {fmtSize(a.size)}
                </div>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {active.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setPreview(a)}
              className="group flex flex-col overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] text-left transition hover:border-[#D4A85A]/60 hover:shadow-[0_6px_16px_rgba(42,36,30,0.12)]"
            >
              <div className="aspect-square w-full overflow-hidden bg-[#F4EDE0]">
                <img
                  src={`/api/assets/${encodeURIComponent(a.id)}`}
                  alt={a.originalName}
                  className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                  loading="lazy"
                />
              </div>
              <div className="p-2">
                <div className="truncate text-xs font-medium text-[#2A241E]">
                  {a.originalName}
                </div>
                <div className="flex items-center justify-between text-[10px] text-[#5A4F42]">
                  <span className="truncate">{shortPath(a.originalPath)}</span>
                  <span className="shrink-0 pl-2">{fmtSize(a.size)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {preview && <PreviewModal asset={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function PreviewModal({
  asset,
  onClose,
}: {
  asset: Asset;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#2A241E]/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-full max-w-5xl overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] shadow-[0_16px_48px_rgba(42,36,30,0.5)]">
        <div className="flex items-center gap-2 border-b border-[#D4C7AE] px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-[#2A241E]">
              {asset.originalName}
            </div>
            <div className="truncate text-[10px] text-[#5A4F42]">
              {asset.originalPath} · {fmtSize(asset.size)}
            </div>
          </div>
          <a
            href={`/api/assets/${encodeURIComponent(asset.id)}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1 text-xs font-medium text-[#2A241E] transition hover:bg-[#EAE1CF]"
          >
            Open
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[6px] p-1 text-[#5A4F42] transition hover:bg-[#F4EDE0]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="flex max-h-[80vh] items-center justify-center overflow-auto bg-[#F4EDE0]">
          <img
            src={`/api/assets/${encodeURIComponent(asset.id)}`}
            alt={asset.originalName}
            className="h-auto max-h-[80vh] w-auto max-w-full"
          />
        </div>
      </div>
    </div>
  );
}

function bucketize(assets: Asset[]): Record<string, Asset[]> {
  const out: Record<string, Asset[]> = { All: [] };
  for (const a of assets) {
    out.All!.push(a);
    const bucket = deriveBucket(a);
    (out[bucket] ??= []).push(a);
  }
  return out;
}

function deriveBucket(a: Asset): string {
  if (!a.mime.startsWith('image/')) return 'Other';
  const segments = a.originalPath.split('/');
  const assetsIdx = segments.findIndex(
    (s) => s.toLowerCase() === 'assets',
  );
  if (assetsIdx >= 0 && assetsIdx + 1 < segments.length - 1) {
    const next = segments[assetsIdx + 1]!;
    return next.charAt(0).toUpperCase() + next.slice(1);
  }
  return 'Images';
}

const BUCKET_ORDER = ['All', 'Portraits', 'Tokens', 'Maps', 'Images', 'Other'];

function bucketSort(a: string, b: string): number {
  const ai = BUCKET_ORDER.indexOf(a);
  const bi = BUCKET_ORDER.indexOf(b);
  if (ai >= 0 && bi >= 0) return ai - bi;
  if (ai >= 0) return -1;
  if (bi >= 0) return 1;
  return a.localeCompare(b);
}

function shortPath(p: string): string {
  const segs = p.split('/');
  if (segs.length <= 2) return p;
  return segs.slice(0, -1).join('/');
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
