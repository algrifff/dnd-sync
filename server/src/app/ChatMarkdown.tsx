'use client';

import type { ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders assistant markdown (GFM) inside chat bubbles — keeps long lines
 * and tables inside the scroll area via `.chat-md` + `min-w-0` parents.
 */
export function ChatMarkdown({
  content,
  className = '',
}: {
  content: string;
  className?: string;
}): ReactElement {
  return (
    <div className={`chat-md min-w-0 max-w-full text-sm leading-relaxed text-[#2A241E] ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...rest }) => (
            <a
              {...rest}
              href={href}
              className="chat-md-link break-all underline decoration-[rgba(139,74,82,0.55)] decoration-[1.5px] underline-offset-[3px]"
              target={href?.startsWith('http') ? '_blank' : undefined}
              rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <pre className="chat-md-pre mb-2 mt-2 max-w-full overflow-x-auto rounded-md border border-[#D4C7AE] bg-[#F4EDE0] p-2.5 text-[13px] leading-snug">
              {children}
            </pre>
          ),
          code: ({ className, children, ...rest }) => {
            const inline = !className;
            if (inline) {
              return (
                <code
                  {...rest}
                  className="rounded bg-[rgba(212,168,90,0.2)] px-1 py-0.5 font-mono text-[0.9em] [overflow-wrap:anywhere]"
                >
                  {children}
                </code>
              );
            }
            return (
              <code {...rest} className={`font-mono text-[13px] ${className ?? ''}`}>
                {children}
              </code>
            );
          },
          table: ({ children }) => (
            <div className="my-2 max-w-full overflow-x-auto rounded-md border border-[#D4C7AE]">
              <table className="w-full min-w-0 border-collapse text-left text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-[#D4C7AE] bg-[#EAE1CF] px-2 py-1.5 font-semibold">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border-b border-[#D4C7AE]/80 px-2 py-1.5 align-top [overflow-wrap:anywhere]">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
