'use client';

import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { Loader2, Send, Sparkles } from 'lucide-react';
import { SessionReviewPanel, type SessionProposal } from './SessionReviewPanel';

const HOME_CHAT_KEY = 'compendium-home-chat-v1';

export function HomeChat({
  groupId,
}: {
  groupId: string;
}): ReactElement {
  const [input, setInput] = useState('');
  const [loaded, setLoaded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: { groupId },
      }),
    [groupId],
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
    <section className="relative flex flex-col rounded-[14px] border border-[#D4C7AE] bg-[#FBF5E8]">
      <header className="flex items-center gap-2 border-b border-[#D4C7AE] px-4 py-2">
        <Sparkles size={14} className="text-[#D4A85A]" aria-hidden />
        <h2 className="text-sm font-semibold text-[#2A241E]">Compendium assistant</h2>
      </header>

      <div className="max-h-[420px] min-h-[240px] flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="mt-2 text-sm text-[#5A4F42]">
            Ask anything about your world. Imports are handled through tools in this same chat.
          </p>
        )}
        <div className="space-y-2">
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
          <div ref={bottomRef} />
        </div>
      </div>

      <footer className="flex items-center gap-2 border-t border-[#D4C7AE] px-3 py-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your campaign..."
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
          disabled={isStreaming || !input.trim()}
          className="rounded-[8px] bg-[#2A241E] p-2 text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-50"
          aria-label="Send"
        >
          <Send size={14} aria-hidden />
        </button>
      </footer>
    </section>
  );
}

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
        <div className="max-w-[85%] rounded-[10px] bg-[#2A241E] px-3 py-1.5 text-sm text-[#F4EDE0]">
          {text}
        </div>
      </div>
    );
  }

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
      <div className="max-w-[92%] whitespace-pre-wrap rounded-[10px] bg-[#F4EDE0] px-3 py-2 text-sm text-[#2A241E]">
        {part.text}
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

    if (state !== 'input-available' && state !== 'output-available') return null;
    return (
      <div className="flex items-center gap-1.5 rounded-[6px] bg-[#D4C7AE]/40 px-2 py-1 text-[11px] text-[#5A4F42]">
        <span className="shrink-0">{toolName}</span>
      </div>
    );
  }

  return null;
}
