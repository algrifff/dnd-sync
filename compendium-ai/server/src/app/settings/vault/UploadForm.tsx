'use client';

import { useState } from 'react';

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
          setState({ kind: 'ok', summary: body.summary as IngestSummary });
        } else {
          setState({
            kind: 'error',
            message:
              body.error === 'rate_limited'
                ? `Too many uploads. Wait ${Math.ceil((body.retryAfterMs ?? 0) / 60_000)} min.`
                : (body.message ?? body.error ?? `HTTP ${xhr.status}`),
          });
        }
      } catch {
        setState({ kind: 'error', message: `HTTP ${xhr.status}` });
      }
    };
    xhr.onerror = () => setState({ kind: 'error', message: 'network error' });
    xhr.send(fd);
    setState({ kind: 'uploading', percent: 0, bytesSent: 0, bytesTotal: file.size });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-[#5A4F42]">Vault ZIP</span>
        <input
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full rounded-[10px] border border-dashed border-[#D4C7AE] bg-[#F4EDE0] px-3 py-6 text-center text-[#5A4F42] file:mr-4 file:rounded-[8px] file:border-0 file:bg-[#2A241E] file:px-3 file:py-2 file:text-[#F4EDE0]"
        />
        {file && (
          <span className="mt-1 block text-xs text-[#5A4F42]">
            {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
          </span>
        )}
      </label>

      {hasExistingNotes && (
        <label className="flex items-start gap-2 rounded-[8px] border border-[#D4A85A]/50 bg-[#D4A85A]/10 px-3 py-2 text-sm text-[#5A4F42]">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-1"
          />
          <span>
            I understand this replaces every note in the vault and disconnects any live editors.
          </span>
        </label>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="rounded-[10px] bg-[#2A241E] px-4 py-2.5 font-medium text-[#F4EDE0] transition hover:scale-[1.015] hover:bg-[#3A342E] disabled:opacity-60 disabled:hover:scale-100"
      >
        {state.kind === 'uploading'
          ? `Uploading ${state.percent}%…`
          : state.kind === 'processing'
            ? 'Ingesting…'
            : 'Upload vault'}
      </button>

      {state.kind === 'uploading' && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-[#EAE1CF]">
          <div
            className="h-full bg-[#D4A85A] transition-[width] duration-200"
            style={{ width: `${state.percent}%` }}
          />
        </div>
      )}

      {state.kind === 'error' && (
        <p className="rounded-[8px] border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-2 text-sm text-[#8B4A52]">
          {state.message}
        </p>
      )}

      {state.kind === 'ok' && (
        <div className="rounded-[10px] border border-[#7B8A5F]/40 bg-[#7B8A5F]/10 p-4 text-sm text-[#2A241E]">
          <h3 className="mb-2 font-semibold">Vault ingested</h3>
          <dl className="grid grid-cols-2 gap-1">
            <dt className="text-[#5A4F42]">Notes</dt>
            <dd>{state.summary.notes}</dd>
            <dt className="text-[#5A4F42]">Assets</dt>
            <dd>
              {state.summary.assets} ({state.summary.assetsReused} reused)
            </dd>
            <dt className="text-[#5A4F42]">Links</dt>
            <dd>{state.summary.links}</dd>
            <dt className="text-[#5A4F42]">Tags</dt>
            <dd>{state.summary.tags}</dd>
            <dt className="text-[#5A4F42]">Duration</dt>
            <dd>{(state.summary.durationMs / 1000).toFixed(1)} s</dd>
          </dl>
          {state.summary.skipped.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[#5A4F42]">
                Skipped ({state.summary.skipped.length})
              </summary>
              <ul className="mt-2 max-h-40 overflow-auto text-xs text-[#5A4F42]">
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
              <summary className="cursor-pointer text-[#8B4A52]">
                Unresolved images (
                {state.summary.unresolvedImages.reduce((n, g) => n + g.refs.length, 0)}
                )
              </summary>
              <p className="mt-2 text-xs text-[#5A4F42]">
                These image references didn&rsquo;t match any asset in the ZIP. Most
                common cause: the image lives in a folder outside the uploaded zip
                or the filename differs from what the note references.
              </p>
              <ul className="mt-2 max-h-40 overflow-auto text-xs text-[#5A4F42]">
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
