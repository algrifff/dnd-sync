'use client';

// Assets gallery — image-first grid with folder-derived bucket
// filters, an upload button, and a detail modal with tag editing.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Upload, X } from 'lucide-react';
import { AssetTagEditor } from './AssetTagEditor';

type Asset = {
  id: string;
  mime: string;
  size: number;
  originalName: string;
  originalPath: string;
  uploadedAt: number;
  tags: string[];
};

export function AssetsGallery({
  assets: initialAssets,
  csrfToken,
  canEdit,
}: {
  assets: Asset[];
  csrfToken: string;
  canEdit: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Asset | null>(null);

  const buckets = useMemo(() => bucketize(initialAssets), [initialAssets]);
  const bucketNames = Object.keys(buckets).sort(bucketSort);
  const [activeBucket, setActiveBucket] = useState<string>(
    bucketNames[0] ?? 'All',
  );

  const handleUpload = useCallback(
    async (files: FileList) => {
      setUploading(true);
      setUploadError(null);
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        try {
          const res = await fetch('/api/assets/upload', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfToken },
            body: form,
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            setUploadError(body.error ?? `Upload failed (HTTP ${res.status})`);
            setUploading(false);
            return;
          }
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : 'network error');
          setUploading(false);
          return;
        }
      }
      setUploading(false);
      router.refresh();
    },
    [csrfToken, router],
  );

  const active = buckets[activeBucket] ?? [];

  return (
    <div>
      {/* Toolbar: bucket chips + upload button */}
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

        <div className="ml-auto flex items-center gap-2">
          {uploadError && (
            <span className="text-xs text-[#8B4A52]">{uploadError}</span>
          )}
          {canEdit && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    void handleUpload(e.target.files);
                    e.target.value = '';
                  }
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1 text-xs font-medium text-[#2A241E] transition hover:bg-[#EAE1CF] disabled:opacity-60"
              >
                <Upload size={12} aria-hidden />
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </>
          )}
        </div>
      </div>

      {initialAssets.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-[#D4C7AE] bg-[#FBF5E8]/60 px-4 py-6 text-sm text-[#5A4F42]">
          No assets yet.{canEdit ? ' Click Upload above to add your first file.' : ''}
        </p>
      ) : activeBucket === 'Other' ? (
        <ul className="divide-y divide-[#D4C7AE]/50 overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8]">
          {active.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setPreview(a)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-[#F4EDE0]"
              >
                <FileText size={14} aria-hidden className="shrink-0 text-[#5A4F42]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[#2A241E]">{a.originalName}</div>
                  <div className="truncate text-xs text-[#5A4F42]">{a.originalPath}</div>
                </div>
                <div className="shrink-0 text-xs text-[#5A4F42]">{fmtSize(a.size)}</div>
              </button>
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
                {a.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {a.tags.slice(0, 3).map((t) => (
                      <span
                        key={t}
                        className="rounded-full border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-1.5 py-px text-[9px] font-medium text-[#5E3A3F]"
                      >
                        #{t}
                      </span>
                    ))}
                    {a.tags.length > 3 && (
                      <span className="text-[9px] text-[#5A4F42]">+{a.tags.length - 3}</span>
                    )}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {preview && (
        <PreviewModal
          asset={preview}
          csrfToken={csrfToken}
          canEdit={canEdit}
          onClose={() => setPreview(null)}
          onTagsChange={(tags) => setPreview((p) => p ? { ...p, tags } : p)}
        />
      )}
    </div>
  );
}

function PreviewModal({
  asset,
  csrfToken,
  canEdit,
  onClose,
  onTagsChange,
}: {
  asset: Asset;
  csrfToken: string;
  canEdit: boolean;
  onClose: () => void;
  onTagsChange: (tags: string[]) => void;
}): React.JSX.Element {
  const isImage = asset.mime.startsWith('image/');
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#2A241E]/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] shadow-[0_16px_48px_rgba(42,36,30,0.5)]">
        {/* Header */}
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

        {/* Preview */}
        {isImage && (
          <div className="flex max-h-[60vh] items-center justify-center overflow-auto bg-[#F4EDE0]">
            <img
              src={`/api/assets/${encodeURIComponent(asset.id)}`}
              alt={asset.originalName}
              className="h-auto max-h-[60vh] w-auto max-w-full"
            />
          </div>
        )}

        {/* Tags */}
        <div className="border-t border-[#D4C7AE] px-3 py-2.5">
          <AssetTagEditor
            assetId={asset.id}
            initialTags={asset.tags}
            csrfToken={csrfToken}
            canEdit={canEdit}
            onTagsChange={onTagsChange}
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
  const assetsIdx = segments.findIndex((s) => s.toLowerCase() === 'assets');
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
