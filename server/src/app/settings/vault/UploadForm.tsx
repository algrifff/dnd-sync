'use client';

import { useState } from 'react';
import posthog from '@/lib/posthog-web';

type IngestSummary = {
  notes: number;
  assets: number;
  assetsReused: number;
  links: number;
  tags: number;
  durationMs: number;
  skipped: Array<{ path: string; reason: string }>;
  unresolvedImages: Array<{ path: string; refs: string[] }>;
};

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; percent: number; bytesSent: number; bytesTotal: number }
  | { kind: 'processing' }
  | { kind: 'ok'; summary: IngestSummary }
  | { kind: 'error'; message: string };

export function UploadForm({
  csrfToken,
  hasExistingNotes,
}: {
  csrfToken: string;
  hasExistingNotes: boolean;
}): React.JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState<boolean>(!hasExistingNotes);
  const [state, setState] = useState<UploadState>({ kind: 'idle' });

  const disabled =
    !file || (hasExistingNotes && !confirmed) || state.kind === 'uploading' || state.kind === 'processing';

  const onSubmit = (evt: React.FormEvent<HTMLFormElement>): void => {
    evt.preventDefault();
    if (!file) return;

    const fd = new FormData();
    fd.set('vault', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/vault/upload');
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      setState({
        kind: 'uploading',
        percent: Math.round((e.loaded / e.total) * 100),
        bytesSent: e.loaded,
        bytesTotal: e.total,
      });
    };
    xhr.upload.onload = () => setState({ kind: 'processing' });
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && body.ok) {
          const summary = body.summary as IngestSummary;
          setState({ kind: 'ok', summary });
          posthog.capture('vault_upload_completed', {
            notes: summary.notes,
            assets: summary.assets,
            assets_reused: summary.assetsReused,
            links: summary.links,
            tags: summary.tags,
            duration_ms: summary.durationMs,
            file_size_bytes: file.size,
          });
        } else {
          const errorMsg =
            body.error === 'rate_limited'
              ? `Too many uploads. Wait ${Math.ceil((body.retryAfterMs ?? 0) / 60_000)} min.`
              : (body.message ?? body.error ?? `HTTP ${xhr.status}`);
          setState({ kind: 'error', message: errorMsg });
          posthog.capture('vault_upload_failed', { error: body.error ?? `HTTP ${xhr.status}`, file_size_bytes: file.size });
        }
      } catch {
        setState({ kind: 'error', message: `HTTP ${xhr.status}` });
        posthog.capture('vault_upload_failed', { error: `HTTP ${xhr.status}`, file_size_bytes: file.size });
      }
    };
    xhr.onerror = () => {
      setState({ kind: 'error', message: 'network error' });
      posthog.capture('vault_upload_failed', { error: 'network_error', file_size_bytes: file.size });
    };
    xhr.send(fd);
    setState({ kind: 'uploading', percent: 0, bytesSent: 0, bytesTotal: file.size });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-[var(--ink-soft)]">Notes ZIP</span>
        <input
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full rounded-[10px] border border-dashed border-[var(--rule)] bg-[var(--parchment)] px-3 py-6 text-center text-[var(--ink-soft)] file:mr-4 file:rounded-[8px] file:border-0 file:bg-[var(--ink)] file:px-3 file:py-2 file:text-[var(--parchment)]"
        />
        {file && (
          <span className="mt-1 block text-xs text-[var(--ink-soft)]">
            {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
          </span>
        )}
      </label>

      {hasExistingNotes && (
        <label className="flex items-start gap-2 rounded-[8px] border border-[var(--candlelight)]/50 bg-[var(--candlelight)]/10 px-3 py-2 text-sm text-[var(--ink-soft)]">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-1"
          />
          <span>
            I understand this replaces all existing notes and disconnects any live editors.
          </span>
        </label>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="rounded-[10px] bg-[var(--ink)] px-4 py-2.5 font-medium text-[var(--parchment)] transition hover:scale-[1.015] hover:bg-[var(--vellum)] disabled:opacity-60 disabled:hover:scale-100"
      >
        {state.kind === 'uploading'
          ? `Uploading ${state.percent}%…`
          : state.kind === 'processing'
            ? 'Ingesting…'
            : 'Import notes'}
      </button>

      {state.kind === 'uploading' && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--parchment-sunk)]">
          <div
            className="h-full bg-[var(--candlelight)] transition-[width] duration-200"
            style={{ width: `${state.percent}%` }}
          />
        </div>
      )}

      {state.kind === 'error' && (
        <p className="rounded-[8px] border border-[var(--wine)]/40 bg-[var(--wine)]/10 px-3 py-2 text-sm text-[var(--wine)]">
          {state.message}
        </p>
      )}

      {state.kind === 'ok' && (
        <div className="rounded-[10px] border border-[var(--moss)]/40 bg-[var(--moss)]/10 p-4 text-sm text-[var(--ink)]">
          <h3 className="mb-2 font-semibold">Import complete</h3>
          <dl className="grid grid-cols-2 gap-1">
            <dt className="text-[var(--ink-soft)]">Notes</dt>
            <dd>{state.summary.notes}</dd>
            <dt className="text-[var(--ink-soft)]">Assets</dt>
            <dd>
              {state.summary.assets} ({state.summary.assetsReused} reused)
            </dd>
            <dt className="text-[var(--ink-soft)]">Links</dt>
            <dd>{state.summary.links}</dd>
            <dt className="text-[var(--ink-soft)]">Tags</dt>
            <dd>{state.summary.tags}</dd>
            <dt className="text-[var(--ink-soft)]">Duration</dt>
            <dd>{(state.summary.durationMs / 1000).toFixed(1)} s</dd>
          </dl>
          {state.summary.skipped.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[var(--ink-soft)]">
                Skipped ({state.summary.skipped.length})
              </summary>
              <ul className="mt-2 max-h-40 overflow-auto text-xs text-[var(--ink-soft)]">
                {state.summary.skipped.map((s) => (
                  <li key={s.path} className="truncate">
                    <code>{s.path}</code> — {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {state.summary.unresolvedImages.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[var(--wine)]">
                Unresolved images (
                {state.summary.unresolvedImages.reduce((n, g) => n + g.refs.length, 0)}
                )
              </summary>
              <p className="mt-2 text-xs text-[var(--ink-soft)]">
                These image references didn&rsquo;t match any asset in the ZIP. Most
                common cause: the image lives in a folder outside the uploaded zip
                or the filename differs from what the note references.
              </p>
              <ul className="mt-2 max-h-40 overflow-auto text-xs text-[var(--ink-soft)]">
                {state.summary.unresolvedImages.map((g) => (
                  <li key={g.path} className="mb-1">
                    <code>{g.path}</code>
                    <ul className="ml-4 list-disc">
                      {g.refs.map((r, i) => (
                        <li key={r + i}>
                          <code>{r}</code>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </form>
  );
}
