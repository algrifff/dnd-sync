'use client';

import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
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
import {
  Loader2,
  Send,
  Sparkles,
  X,
  Paperclip,
  FolderOpen,
  Trash2,
  CalendarDays,
  Sword,
  UserRound,
  Skull,
  Package,
  Ghost,
  type LucideIcon,
} from 'lucide-react';
import { ChatMarkdown } from './ChatMarkdown';
import { SessionReviewPanel, type SessionProposal } from './SessionReviewPanel';
import { noteEditorHref, useRefreshTreeOnAiNoteMutations } from './chat-tree-refresh';
import { chatStorageKey, cleanupLegacyChatStorage } from './chat-storage';
import posthog from '@/lib/posthog-web';

// ── File attachment helpers (shared shape with ChatPane) ───────────────

type AttachedFile = {
  id: string;
  name: string;
  kind: 'text' | 'image';
  content: string;
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
  if (dot === -1) return true;
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

// ── HomeChat component ─────────────────────────────────────────────────

export function HomeChat({
  groupId,
  userId,
}: {
  groupId: string;
  userId: string;
}): ReactElement {
  const [input, setInput] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const skipInitialScroll = useRef(true);
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
        body: { groupId },
      }),
    [groupId],
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
    skipInitialScroll.current = true;
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
    if (!loaded) return;
    if (skipInitialScroll.current) {
      skipInitialScroll.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [loaded, messages, isStreaming]);

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

    posthog.capture('ai_message_sent', {
      has_attachments: attachedFiles.length > 0,
      attachment_count: attachedFiles.length,
      has_images: imageFiles.length > 0,
      role: 'dm',
    });

    if (imageParts.length > 0) {
      void sendMessage({ text: fullText || 'Please look at the attached image(s).', files: imageParts });
    } else {
      void sendMessage({ text: fullText });
    }
  }

  function clearChat() {
    posthog.capture('ai_chat_cleared');
    setMessages([]);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }

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

  function quickSend(prompt: string) {
    if (isStreaming) return;
    const action = QUICK_ACTIONS.find((a) => a.prompt === prompt);
    posthog.capture('ai_quick_action_triggered', { action_key: action?.key ?? 'unknown' });
    void sendMessage({ text: prompt });
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
    <section className="relative flex min-w-0 flex-col rounded-[14px] border border-[#D4C7AE] bg-[#FBF5E8]">
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

      {/* Header */}
      <header className="flex items-center gap-2 border-b border-[#D4C7AE] px-4 py-2">
        <Sparkles size={14} className="text-[#D4A85A]" aria-hidden />
        <h2 className="flex-1 text-sm font-semibold text-[#2A241E]">Compendium assistant</h2>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={clearChat}
            aria-label="Clear chat history"
            title="Clear chat"
            className="flex h-6 w-6 items-center justify-center rounded-full text-[#5A4F42] transition-colors hover:bg-[#D4C7AE]/55 hover:text-[#8B4A52] active:scale-95"
          >
            <Trash2 size={12} aria-hidden />
          </button>
        )}
      </header>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="max-h-[420px] min-h-[240px] min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3"
      >
        {messages.length === 0 && (
          <p className="mt-2 text-sm text-[#5A4F42]">
            Ask anything about your world. Attach notes, images, ZIPs, or PDFs.
          </p>
        )}
        <div className="min-w-0 space-y-2">
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              role="dm"
              onApplySession={onApplySession}
            />
          ))}
          {isStreaming && (
            <div className="flex items-center gap-1.5 text-xs text-[#5A4F42]">
              <Loader2 size={11} className="animate-spin" aria-hidden />
              Thinking…
            </div>
          )}
        </div>
      </div>

      {/* Attachment badges */}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-[#D4C7AE] px-3 pt-2 pb-1">
          {attachedFiles.map((f) => (
            <AttachmentBadge key={f.id} file={f} onRemove={removeAttachment} />
          ))}
        </div>
      )}

      {/* Input footer */}
      <footer className="flex items-center gap-1.5 border-t border-[#D4C7AE] px-3 py-2">
        {/* Attach files */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach files"
          title="Attach files (text, images, ZIPs, PDFs)"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E] active:scale-95"
        >
          <Paperclip size={13} aria-hidden />
        </button>

        {/* Attach folder */}
        <button
          type="button"
          onClick={() => folderInputRef.current?.click()}
          aria-label="Attach folder"
          title="Attach entire folder"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E] active:scale-95"
        >
          <FolderOpen size={13} aria-hidden />
        </button>

        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={attachedFiles.length > 0 ? 'Add a message…' : 'Ask about your campaign...'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          className="flex-1 rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={isStreaming || anyLoading || (!input.trim() && attachedFiles.length === 0)}
          className="rounded-[8px] bg-[#2A241E] p-2 text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-50"
          aria-label="Send"
        >
          {anyLoading
            ? <Loader2 size={14} className="animate-spin" aria-hidden />
            : <Send size={14} aria-hidden />
          }
        </button>
      </footer>
    </section>

      {/* Quick-create shortcuts — one-click prompts that fire the AI's
          entity_create flow. Tooltips are custom (instant) — no native
          title delay. */}
      <QuickActionsRow disabled={isStreaming} onPick={quickSend} />
    </div>
  );
}

// ── Quick actions ──────────────────────────────────────────────────────

// Each quick action fills the button with a muted earth-tone drawn
// from the app's parchment palette; the icon sits on top in cream
// (#F4EDE0), the same light text colour used on every dark control in
// the app (Send button, user chat bubbles). On hover the fill darkens
// one step — no lifts or drop-shadows, to stay in the design system's
// "calm, borders-first" register.
const QUICK_ACTIONS: ReadonlyArray<{
  key: string;
  icon: LucideIcon;
  label: string;
  prompt: string;
  /** Tailwind bg + hover-bg, kept literal so JIT emits them. */
  tone: string;
}> = [
  { key: 'session',   icon: CalendarDays, label: 'New session',   prompt: 'Start a new session.',             tone: 'bg-[#B88832] hover:bg-[#9C6F22]' }, // muted gold ink
  { key: 'character', icon: Sword,        label: 'New character', prompt: 'Create a new player character.',  tone: 'bg-[#5B6B8A] hover:bg-[#495775]' }, // dusty steel
  { key: 'person',    icon: UserRound,    label: 'New person',    prompt: 'Create a new person (NPC).',       tone: 'bg-[#7A6249] hover:bg-[#624E38]' }, // walnut
  { key: 'enemy',     icon: Skull,        label: 'New enemy',     prompt: 'Create a new enemy.',              tone: 'bg-[#8B4A52] hover:bg-[#743C43]' }, // app burgundy
  { key: 'item',      icon: Package,      label: 'New item',      prompt: 'Create a new item.',               tone: 'bg-[#9C7A2E] hover:bg-[#836520]' }, // tarnished bronze
  { key: 'creature',  icon: Ghost,        label: 'New creature',  prompt: 'Create a new creature.',           tone: 'bg-[#6B5B7A] hover:bg-[#574866]' }, // dusk violet
];

function QuickActionsRow({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (prompt: string) => void;
}): ReactElement {
  return (
    <div className="flex w-full items-center justify-between gap-2 px-1">
      {QUICK_ACTIONS.map(({ key, icon: Icon, label, prompt, tone }) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(prompt)}
          disabled={disabled}
          aria-label={label}
          className={`group relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#F4EDE0] transition-colors duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${tone}`}
        >
          <Icon size={18} aria-hidden />
          <span
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-[6px] bg-[#2A241E] px-2 py-1 text-[11px] font-medium text-[#F4EDE0] opacity-0 shadow-lg group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            {label}
          </span>
        </button>
      ))}
    </div>
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

    // Strip injected <file ...> blocks from display
    const displayText = text.replace(/<file name="[^"]*">[\s\S]*?<\/file>/g, '').trim();

    if (!displayText && fileParts.length === 0) return null;

    return (
      <div className="flex min-w-0 justify-end">
        <div className="flex max-w-[min(85%,100%)] min-w-0 flex-col items-end gap-1">
          {fileParts.map((p, i) => (
            <UserFilePart key={i} part={p} />
          ))}
          {displayText && (
            <div className="break-words rounded-[10px] bg-[#2A241E] px-3 py-1.5 text-sm text-[#F4EDE0]">
              {displayText}
            </div>
          )}
          {!displayText && fileParts.length > 0 && (
            <div className="rounded-[10px] bg-[#2A241E] px-3 py-1.5 text-sm text-[#F4EDE0] opacity-70">
              {fileParts.length === 1 ? '1 file attached' : `${fileParts.length} files attached`}
            </div>
          )}
        </div>
      </div>
    );
  }

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

function baseName(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/i, '') ?? path;
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
      <div className="max-w-[min(92%,100%)] min-w-0 overflow-hidden rounded-[10px] bg-[#F4EDE0] px-3 py-2 text-[#2A241E]">
        <ChatMarkdown content={part.text} />
      </div>
    );
  }

  if (isToolUIPart(part)) {
    const toolName = 'toolName' in part ? part.toolName : part.type.replace(/^tool-/, '');
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
          <div className="flex max-w-[min(92%,100%)] min-w-0 flex-col gap-1.5 rounded-[10px] bg-[#F4EDE0] px-3 py-2 text-[#2A241E]">
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
          <div className="max-w-[min(92%,100%)] min-w-0 rounded-[10px] bg-[#F4E4E4] px-3 py-2 text-[12px] text-[#6B2F38]">
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
          <div className="flex max-w-[min(92%,100%)] min-w-0 flex-col gap-1.5 rounded-[10px] bg-[#F4EDE0] px-3 py-2 text-[#2A241E]">
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
    return (
      <div className="flex items-center gap-1.5 rounded-[6px] bg-[#D4C7AE]/40 px-2 py-1 text-[11px] text-[#5A4F42]">
        <span className="shrink-0">{toolName}</span>
      </div>
    );
  }

  return null;
}
