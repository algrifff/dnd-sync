'use client';

// Slide-in AI chat panel. Renders as a fixed right-edge overlay with a
// FAB toggle. Streams responses from /api/chat using the AI SDK useChat hook.
// Supports file / folder / ZIP / image / PDF attachments and a clear-chat action.

import type { ReactElement } from 'react';
import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  isTextUIPart,
  isToolUIPart,
  isFileUIPart,
  type UIMessage,
  type UIMessagePart,
  type UIDataTypes,
  type UITools,
  type FileUIPart,
} from 'ai';
import { Loader2, Send, Sparkles, X, Paperclip, FolderOpen, Trash2 } from 'lucide-react';
import { ChatMarkdown } from './ChatMarkdown';
import { SessionReviewPanel, type SessionProposal } from './SessionReviewPanel';
import { noteEditorHref, useRefreshTreeOnAiNoteMutations } from './chat-tree-refresh';
import { chatStorageKey, cleanupLegacyChatStorage } from './chat-storage';

// ── File attachment types ───────────────────────────────────────────────

type AttachedFile = {
  id: string;
  name: string;
  kind: 'text' | 'image';
  content: string; // plain text or data URL
  mediaType?: string;
  loading: boolean;
  error?: string;
};

const TEXT_EXTS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.xml',
  '.html', '.htm', '.js', '.ts', '.jsx', '.tsx', '.py',
  '.toml', '.ini', '.conf', '.log', '.rst', '.tex', '.org',
  '.css', '.scss', '.sql',
]);

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return true; // no extension — try as text
  return TEXT_EXTS.has(lower.slice(dot));
}

function isServerSideFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.zip') || lower.endsWith('.pdf');
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function uploadForExtraction(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/chat/upload', { method: 'POST', body: form });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { reason?: string };
    throw new Error(err.reason ?? 'Upload failed');
  }
  const data = (await res.json()) as { content: string };
  return data.content;
}

// ── Public component ───────────────────────────────────────────────────

export function ChatPane({
  groupId,
  userId,
  campaignSlug,
  role,
}: {
  groupId: string;
  userId: string;
  campaignSlug?: string | undefined;
  role: 'dm' | 'player';
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const router = useRouter();

  const storageKey = useMemo(
    () => chatStorageKey(userId, groupId),
    [userId, groupId],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: {
          groupId,
          ...(campaignSlug !== undefined ? { campaignSlug } : {}),
        },
      }),
    [groupId, campaignSlug],
  );

  const { messages, status, sendMessage, setMessages } = useChat({ transport });

  useRefreshTreeOnAiNoteMutations(messages, () => {
    router.refresh();
  });

  const isStreaming = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    // Re-runs when storageKey changes (i.e. the active world or user
    // changes). Reset in-memory messages first so the old world's chat
    // does not flash in while we read the new one.
    cleanupLegacyChatStorage();
    setLoaded(false);
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as UIMessage[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
        } else {
          setMessages([]);
        }
      } else {
        setMessages([]);
      }
    } catch {
      setMessages([]);
    } finally {
      setLoaded(true);
    }
  }, [setMessages, storageKey]);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(messages));
    } catch {
      // Ignore local storage failures.
    }
  }, [loaded, messages, storageKey]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [open, messages, isStreaming]);

  // ── File handling ──────────────────────────────────────────────────

  const processFiles = useCallback(async (fileList: File[]) => {
    for (const file of fileList) {
      const id = Math.random().toString(36).slice(2);

      setAttachedFiles((prev) => [
        ...prev,
        { id, name: file.name, kind: 'text', content: '', loading: true },
      ]);

      try {
        if (file.type.startsWith('image/')) {
          if (file.size > 8 * 1024 * 1024) throw new Error('Image too large (max 8 MB)');
          const url = await readAsDataURL(file);
          setAttachedFiles((prev) =>
            prev.map((f) =>
              f.id === id
                ? { ...f, kind: 'image', content: url, mediaType: file.type, loading: false }
                : f,
            ),
          );
        } else if (isServerSideFile(file.name)) {
          const text = await uploadForExtraction(file);
          setAttachedFiles((prev) =>
            prev.map((f) => (f.id === id ? { ...f, content: text, loading: false } : f)),
          );
        } else if (isTextFile(file.name)) {
          if (file.size > 500 * 1024) throw new Error('File too large (max 500 KB)');
          const text = await readAsText(file);
          setAttachedFiles((prev) =>
            prev.map((f) => (f.id === id ? { ...f, content: text, loading: false } : f)),
          );
        } else {
          throw new Error('Unsupported file type');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to read file';
        setAttachedFiles((prev) =>
          prev.map((f) => (f.id === id ? { ...f, loading: false, error: msg } : f)),
        );
      }
    }
  }, []);

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;
    void processFiles(Array.from(e.target.files));
    e.target.value = '';
  }

  function removeAttachment(id: string) {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  }

  // ── Submit ─────────────────────────────────────────────────────────

  function submit() {
    const text = input.trim();
    if (isStreaming) return;
    if (!text && attachedFiles.length === 0) return;
    if (attachedFiles.some((f) => f.loading)) return;

    const textFiles = attachedFiles.filter((f) => f.kind === 'text' && !f.error);
    const imageFiles = attachedFiles.filter((f) => f.kind === 'image' && !f.error);

    let fullText = text;
    if (textFiles.length > 0) {
      const ctx = textFiles
        .map((f) => `<file name="${f.name}">\n${f.content}\n</file>`)
        .join('\n\n');
      fullText = `${ctx}\n\n${text}`.trim();
    }

    const imageParts: FileUIPart[] = imageFiles.map((f) => ({
      type: 'file' as const,
      mediaType: f.mediaType ?? 'image/png',
      url: f.content,
    }));

    setInput('');
    setAttachedFiles([]);

    if (imageParts.length > 0) {
      void sendMessage({ text: fullText || 'Please look at the attached image(s).', files: imageParts });
    } else {
      void sendMessage({ text: fullText });
    }
  }

  function clearChat() {
    setMessages([]);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }

  // ── Session apply ──────────────────────────────────────────────────

  function onApplySession(
    sessionPath: string,
    approvedChanges: Array<{ id: string; approved: boolean }>,
  ) {
    const json = JSON.stringify(approvedChanges);
    void sendMessage({
      text: `Apply the approved session changes. Call session_apply with sessionPath="${sessionPath}" and approvedChanges=${json}`,
    });
  }

  const anyLoading = attachedFiles.some((f) => f.loading);

  return (
    <>
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="*"
        className="sr-only"
        onChange={onFileInput}
        aria-hidden
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error — webkitdirectory is not in React's HTMLInputElement typings
        webkitdirectory="true"
        multiple
        className="sr-only"
        onChange={onFileInput}
        aria-hidden
      />

      {/* Floating action button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close Compendium AI' : 'Open Compendium AI'}
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
        className={`fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-[#D4A85A] text-white shadow-[0_4px_16px_rgba(42,36,30,0.25)] transition-all duration-200 ease-out hover:bg-[#C49848] active:scale-95 ${
          open ? 'pointer-events-none scale-90 opacity-0' : 'opacity-100'
        }`}
      >
        <Sparkles size={18} aria-hidden />
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-6 right-6 top-[42px] z-30 flex min-h-0 min-w-0 w-[min(300px,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl border border-[#D4C7AE] bg-[#FBF5E8] shadow-[0_12px_40px_rgba(42,36,30,0.14)] transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none sm:w-[min(320px,calc(100vw-3rem))]">

          {/* Header */}
          <div className="flex shrink-0 items-center gap-2 border-b border-[#D4C7AE] px-2 py-2.5 pr-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close AI panel"
              className="order-first flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#5A4F42] transition-colors hover:bg-[#D4C7AE]/55 active:scale-95"
            >
              <X size={16} strokeWidth={2} aria-hidden />
            </button>
            <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-[#2A241E]">
              <Sparkles size={13} className="shrink-0 text-[#D4A85A]" aria-hidden />
              <span className="truncate">Compendium AI</span>
            </span>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={clearChat}
                aria-label="Clear chat history"
                title="Clear chat"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#5A4F42] transition-colors hover:bg-[#D4C7AE]/55 hover:text-[#8B4A52] active:scale-95"
              >
                <Trash2 size={13} aria-hidden />
              </button>
            )}
          </div>

          {/* Message list */}
          <div
            ref={scrollRef}
            className="flex min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4"
          >
            {messages.length === 0 && (
              <p className="mt-10 text-center text-xs text-[#5A4F42]">
                Ask me anything about your campaign.<br />
                <span className="text-[#5A4F42]/60">Attach files, images, or ZIP vaults.</span>
              </p>
            )}

            <div className="min-w-0 space-y-3">
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  role={role}
                  onApplySession={onApplySession}
                />
              ))}
            </div>

            {isStreaming && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-[#5A4F42]">
                <Loader2 size={11} className="animate-spin" aria-hidden />
                Thinking…
              </div>
            )}
          </div>

          {/* Attachment badges */}
          {attachedFiles.length > 0 && (
            <div className="shrink-0 flex flex-wrap gap-1.5 border-t border-[#D4C7AE] px-3 pt-2 pb-1">
              {attachedFiles.map((f) => (
                <AttachmentBadge key={f.id} file={f} onRemove={removeAttachment} />
              ))}
            </div>
          )}

          {/* Input area */}
          <div className="shrink-0 border-t border-[#D4C7AE] px-3 py-3">
            <div className="flex items-end gap-1.5">
              {/* Attach files button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach files"
                title="Attach files (text, images, ZIPs, PDFs)"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E] active:scale-95"
              >
                <Paperclip size={14} aria-hidden />
              </button>

              {/* Attach folder button */}
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                aria-label="Attach folder"
                title="Attach entire folder"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E] active:scale-95"
              >
                <FolderOpen size={14} aria-hidden />
              </button>

              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={attachedFiles.length > 0 ? 'Add a message…' : 'Ask about your campaign…'}
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                className="flex-1 resize-none rounded-[8px] border border-[#D4C7AE] bg-white px-3 py-2 text-sm text-[#2A241E] placeholder:text-[#5A4F42]/50 focus:border-[#D4A85A] focus:outline-none"
              />

              <button
                onClick={submit}
                disabled={isStreaming || anyLoading || (!input.trim() && attachedFiles.length === 0)}
                aria-label="Send message"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#D4A85A] text-white transition hover:bg-[#C49848] disabled:opacity-40"
              >
                {anyLoading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} />}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Attachment badge ────────────────────────────────────────────────────

function AttachmentBadge({
  file,
  onRemove,
}: {
  file: AttachedFile;
  onRemove: (id: string) => void;
}): ReactElement {
  return (
    <div
      className={`flex max-w-[160px] items-center gap-1 rounded-[6px] px-2 py-0.5 text-[11px] ${
        file.error
          ? 'bg-[#8B4A52]/15 text-[#8B4A52]'
          : 'bg-[#D4C7AE]/50 text-[#5A4F42]'
      }`}
    >
      {file.loading && <Loader2 size={9} className="shrink-0 animate-spin" aria-hidden />}
      {file.kind === 'image' && !file.loading && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={file.content}
          alt=""
          className="h-4 w-4 shrink-0 rounded-[2px] object-cover"
        />
      )}
      <span className="truncate">{file.error ?? file.name}</span>
      <button
        type="button"
        onClick={() => onRemove(file.id)}
        aria-label={`Remove ${file.name}`}
        className="ml-0.5 shrink-0 opacity-60 hover:opacity-100"
      >
        <X size={9} aria-hidden />
      </button>
    </div>
  );
}

// ── Message rendering ──────────────────────────────────────────────────

function MessageBubble({
  msg,
  role,
  onApplySession,
}: {
  msg: UIMessage;
  role: 'dm' | 'player';
  onApplySession: (sessionPath: string, changes: Array<{ id: string; approved: boolean }>) => void;
}): ReactElement | null {
  if (msg.role === 'user') {
    const textParts = msg.parts.filter(isTextUIPart);
    const fileParts = msg.parts.filter(isFileUIPart);
    const text = textParts.map((p) => p.text).join('');

    // Strip injected <file ...> blocks from display — show only the human text
    const displayText = text.replace(/<file name="[^"]*">[\s\S]*?<\/file>/g, '').trim();

    if (!displayText && fileParts.length === 0) return null;

    return (
      <div className="flex min-w-0 justify-end">
        <div className="flex max-w-[min(85%,100%)] min-w-0 flex-col items-end gap-1">
          {fileParts.map((p, i) => (
            <UserFilePart key={i} part={p} />
          ))}
          {displayText && (
            <div className="break-words rounded-[10px] rounded-tr-[4px] bg-[#D4A85A] px-3 py-2 text-sm text-white">
              {displayText}
            </div>
          )}
          {!displayText && fileParts.length > 0 && (
            <div className="rounded-[10px] rounded-tr-[4px] bg-[#D4A85A] px-3 py-2 text-sm text-white opacity-70">
              {fileParts.length === 1 ? '1 file attached' : `${fileParts.length} files attached`}
            </div>
          )}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-2">
      {msg.parts.map((part, i) => (
        <AssistantPart
          key={i}
          part={part}
          role={role}
          onApplySession={onApplySession}
        />
      ))}
    </div>
  );
}

function UserFilePart({ part }: { part: FileUIPart }): ReactElement {
  if (part.mediaType.startsWith('image/')) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={part.url}
        alt="Attached image"
        className="max-h-40 max-w-full rounded-[8px] object-contain"
      />
    );
  }
  return (
    <div className="rounded-[6px] bg-[#D4C7AE]/40 px-2 py-1 text-[11px] text-[#5A4F42]">
      📎 file attached
    </div>
  );
}

function AssistantPart({
  part,
  role,
  onApplySession,
}: {
  part: UIMessagePart<UIDataTypes, UITools>;
  role: 'dm' | 'player';
  onApplySession: (sessionPath: string, changes: Array<{ id: string; approved: boolean }>) => void;
}): ReactElement | null {
  if (isTextUIPart(part)) {
    if (!part.text) return null;
    return (
      <div className="max-w-[min(92%,100%)] min-w-0 overflow-hidden rounded-[10px] rounded-tl-[4px] bg-[#EAE1CF] px-3 py-2 text-[#2A241E]">
        <ChatMarkdown content={part.text} />
      </div>
    );
  }

  if (isToolUIPart(part)) {
    const toolName =
      'toolName' in part ? part.toolName : part.type.replace(/^tool-/, '');
    const state = part.state;

    if (toolName === 'session_close' && state === 'output-available' && role === 'dm') {
      const output = part.output as { ok: boolean; proposal?: SessionProposal } | undefined;
      if (output?.ok && output.proposal) {
        return (
          <SessionReviewPanel
            proposal={output.proposal}
            onApply={onApplySession}
          />
        );
      }
    }

    if (toolName === 'entity_create' && state === 'output-available') {
      const output = part.output as
        | { ok?: boolean; path?: string; error?: string; message?: string }
        | undefined;
      if (output?.ok && output.path) {
        const title = baseName(output.path);
        return (
          <div className="flex max-w-[min(92%,100%)] min-w-0 flex-col gap-1.5 rounded-[10px] rounded-tl-[4px] bg-[#EAE1CF] px-3 py-2 text-[#2A241E]">
            <div className="flex items-center gap-1.5 text-[11px] text-[#5A4F42]">
              <span className="shrink-0 font-medium">Created</span>
              <span className="truncate text-[#5A4F42]/80">· {title}</span>
            </div>
            <Link
              href={noteEditorHref(output.path)}
              className="text-sm font-medium text-[#8B4A52] underline decoration-[rgba(139,74,82,0.45)] underline-offset-2 hover:text-[#6B2F38]"
            >
              Open in vault →
            </Link>
          </div>
        );
      }
      if (output && output.ok === false) {
        const reason = String(output.message ?? output.error ?? 'failed');
        return (
          <div className="max-w-[min(92%,100%)] min-w-0 rounded-[10px] rounded-tl-[4px] bg-[#F4E4E4] px-3 py-2 text-[12px] text-[#6B2F38]">
            Create failed: {reason}
          </div>
        );
      }
    }

    if (toolName === 'entity_move' && state === 'output-available') {
      const output = part.output as { ok?: boolean; path?: string; error?: string } | undefined;
      if (output?.ok && output.path) {
        const title = baseName(output.path);
        return (
          <div className="flex max-w-[min(92%,100%)] min-w-0 flex-col gap-1.5 rounded-[10px] rounded-tl-[4px] bg-[#EAE1CF] px-3 py-2 text-[#2A241E]">
            <div className="flex items-center gap-1.5 text-[11px] text-[#5A4F42]">
              <span className="shrink-0 font-medium">Moved</span>
              <span className="truncate text-[#5A4F42]/80">· {title}</span>
            </div>
            <Link
              href={noteEditorHref(output.path)}
              className="text-sm font-medium text-[#8B4A52] underline decoration-[rgba(139,74,82,0.45)] underline-offset-2 hover:text-[#6B2F38]"
            >
              Open in vault →
            </Link>
          </div>
        );
      }
    }

    if (state !== 'input-available' && state !== 'output-available') return null;

    const label = TOOL_LABELS[toolName] ?? toolName;
    const hint = getToolHint(toolName, part.input as Record<string, unknown>);

    return (
      <div className="flex items-center gap-1.5 rounded-[6px] bg-[#D4C7AE]/40 px-2 py-1 text-[11px] text-[#5A4F42]">
        <span className="shrink-0">{label}</span>
        {hint && <span className="text-[#5A4F42]/60">· {hint}</span>}
      </div>
    );
  }

  return null;
}

// ── Tool label helpers ────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  campaign_list:       'Listed campaigns',
  entity_search:       'Searched',
  entity_create:       'Created',
  entity_edit_sheet:   'Updated',
  entity_edit_content: 'Appended to',
  entity_move:         'Moved',
  backlink_create:     'Linked',
  inventory_add:       'Added to inventory',
  session_close:       'Session analysed',
  session_apply:       'Session applied',
};

function getToolHint(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'entity_search') return String(input.query ?? '');
  if (toolName === 'entity_create') return String(input.name ?? '');
  if (toolName === 'entity_edit_sheet' || toolName === 'entity_edit_content' || toolName === 'entity_move') {
    return baseName(String(input.path ?? input.from ?? ''));
  }
  if (toolName === 'backlink_create') return baseName(String(input.fromPath ?? ''));
  if (toolName === 'session_close' || toolName === 'session_apply') {
    return baseName(String(input.sessionPath ?? ''));
  }
  if (toolName === 'inventory_add') return baseName(String(input.characterPath ?? ''));
  return '';
}

function baseName(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/i, '') ?? path;
}
