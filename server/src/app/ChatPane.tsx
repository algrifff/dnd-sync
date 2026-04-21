'use client';

// Slide-in AI chat panel. Renders as a fixed right-edge overlay with a
// FAB toggle. Streams responses from /api/chat using the AI SDK useChat hook.
// Tool invocations are shown inline; session_close proposals render a
// SessionReviewPanel for per-change DM approval.

import type { ReactElement } from 'react';
import { useRef, useEffect, useState, useMemo } from 'react';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
  type UIMessagePart,
  type UIDataTypes,
  type UITools,
} from 'ai';
import { ChevronRight, Loader2, Send, Sparkles, X } from 'lucide-react';
import { SessionReviewPanel, type SessionProposal } from './SessionReviewPanel';

const HOME_CHAT_KEY = 'compendium-home-chat-v1';

// ── Public component ───────────────────────────────────────────────────

export function ChatPane({
  groupId,
  campaignSlug,
  role,
}: {
  groupId: string;
  campaignSlug?: string | undefined;
  role: 'dm' | 'player';
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loaded, setLoaded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

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

  const isStreaming = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HOME_CHAT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as UIMessage[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
        }
      }
    } catch {
      // Ignore local storage failures.
    } finally {
      setLoaded(true);
    }
  }, [setMessages]);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(HOME_CHAT_KEY, JSON.stringify(messages));
    } catch {
      // Ignore local storage failures.
    }
  }, [loaded, messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  function submit() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    void sendMessage({ text });
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

  return (
    <>
      {/* Floating action button */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close Compendium AI' : 'Open Compendium AI'}
        className="fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-[#D4A85A] text-white shadow-[0_4px_16px_rgba(42,36,30,0.25)] transition hover:bg-[#C49848] active:scale-95"
      >
        {open ? <X size={18} /> : <Sparkles size={18} />}
      </button>

      {/* Chat panel */}
      {open && (
        <div
          className="fixed bottom-0 right-0 z-30 flex flex-col border-l border-[#D4C7AE] bg-[#FBF5E8] shadow-[-4px_0_24px_rgba(42,36,30,0.12)]"
          style={{ top: 42, width: 340 }}
        >
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-[#D4C7AE] px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-[#2A241E]">
              <Sparkles size={13} className="text-[#D4A85A]" aria-hidden />
              Compendium AI
            </span>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close AI panel"
              className="rounded-[5px] p-1 text-[#5A4F42] transition hover:bg-[#D4C7AE]/50"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Message list */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <p className="mt-10 text-center text-xs text-[#5A4F42]">
                Ask me anything about your campaign.
              </p>
            )}

            <div className="space-y-3">
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

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-[#D4C7AE] px-3 py-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about your campaign…"
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
                disabled={isStreaming || !input.trim()}
                aria-label="Send message"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#D4A85A] text-white transition hover:bg-[#C49848] disabled:opacity-40"
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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
    const text = msg.parts
      .filter((p): p is Extract<UIMessagePart<UIDataTypes, UITools>, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
    if (!text) return null;
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[10px] rounded-tr-[4px] bg-[#D4A85A] px-3 py-2 text-sm text-white">
          {text}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex flex-col gap-2">
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
      <div className="max-w-[92%] whitespace-pre-wrap rounded-[10px] rounded-tl-[4px] bg-[#EAE1CF] px-3 py-2 text-sm text-[#2A241E]">
        {part.text}
      </div>
    );
  }

  if (isToolUIPart(part)) {
    const toolName =
      'toolName' in part ? part.toolName : part.type.replace(/^tool-/, '');
    const state = part.state;

    // session_close — render the review panel for DMs
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

    // Only show a badge once the tool has been called (not while streaming input)
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
