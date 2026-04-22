'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Sparkles, Loader2, X } from 'lucide-react';

type UploadState = 'idle' | 'uploading' | 'error';

export function ImportLauncher({ csrfToken }: { csrfToken: string }): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const reset = (): void => {
    setFile(null);
    setState('idle');
    setProgress(0);
    setError(null);
  };

  const close = (): void => {
    if (state === 'uploading') return;
    setOpen(false);
    reset();
  };

  const start = (): void => {
    if (!file || state === 'uploading') return;
    setState('uploading');
    setError(null);

    const fd = new FormData();
    fd.set('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/import');
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);

    xhr.upload.onprogress = (e): void => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = (): void => {
      try {
        const body = JSON.parse(xhr.responseText) as {
          ok?: boolean;
          job?: { id: string };
          error?: string;
          message?: string;
        };
        if (xhr.status >= 200 && xhr.status < 300 && body.ok && body.job) {
          router.push(`/settings/import/${body.job.id}`);
        } else {
          setState('error');
          setError(body.message ?? body.error ?? `Upload failed (${xhr.status})`);
        }
      } catch {
        setState('error');
        setError(`Upload failed (${xhr.status})`);
      }
    };

    xhr.onerror = (): void => {
      setState('error');
      setError('Network error — check your connection and try again.');
    };

    xhr.send(fd);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-[#2A241E] px-4 py-3 text-sm font-medium text-[#F4EDE0] transition hover:bg-[#3A342E]"
      >
        <Sparkles size={14} aria-hidden />
        Import Notes
      </button>

      {open && mounted && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#2A241E]/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          <div className="relative mx-4 w-full max-w-md rounded-[14px] border border-[#D4C7AE] bg-[#F4EDE0] shadow-2xl">

            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#D4C7AE] px-5 py-4">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-[#D4A85A]" aria-hidden />
                <span className="text-sm font-semibold text-[#2A241E]">Import Notes</span>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={state === 'uploading'}
                aria-label="Close"
                className="rounded-full p-1 text-[#5A4F42] transition hover:bg-[#D4C7AE]/60 hover:text-[#2A241E] disabled:opacity-40"
              >
                <X size={15} aria-hidden />
              </button>
            </div>

            {/* Body */}
            <div className="space-y-4 px-5 py-5">
              <p className="text-sm text-[#5A4F42]">
                Drop in a ZIP of your notes. The AI will classify characters, locations, items,
                sessions, and lore — pausing to ask you only when something is genuinely ambiguous.
                You get a summary at the end, not a wall of rows to click through.
              </p>

              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-[#5A4F42]">Notes ZIP</span>
                <input
                  type="file"
                  accept=".zip,application/zip"
                  disabled={state === 'uploading'}
                  onChange={(e) => {
                    setError(null);
                    setFile(e.target.files?.[0] ?? null);
                  }}
                  className="w-full rounded-[10px] border border-dashed border-[#D4C7AE] bg-[#FBF5E8] px-3 py-5 text-center text-sm text-[#5A4F42] file:mr-3 file:rounded-[6px] file:border-0 file:bg-[#2A241E] file:px-3 file:py-1.5 file:text-xs file:text-[#F4EDE0] disabled:opacity-60"
                />
                {file && (
                  <span className="mt-1 block text-xs text-[#5A4F42]">
                    {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                )}
              </label>

              {state === 'uploading' && (
                <div className="space-y-1.5">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#EAE1CF]">
                    <div
                      className="h-full bg-[#D4A85A] transition-[width] duration-200"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <p className="text-center text-xs text-[#5A4F42]">Uploading {progress}%…</p>
                </div>
              )}

              {error && (
                <p className="rounded-[8px] border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-2 text-xs text-[#8B4A52]">
                  {error}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={close}
                  disabled={state === 'uploading'}
                  className="rounded-[8px] px-3 py-2 text-sm text-[#5A4F42] transition hover:text-[#2A241E] disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={start}
                  disabled={!file || state === 'uploading'}
                  className="flex items-center gap-2 rounded-[10px] bg-[#2A241E] px-4 py-2 text-sm font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-50"
                >
                  {state === 'uploading' ? (
                    <><Loader2 size={13} className="animate-spin" aria-hidden />Uploading…</>
                  ) : (
                    <><Sparkles size={13} aria-hidden />Start Smart Import</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
