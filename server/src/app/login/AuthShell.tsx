// Shared layout for every auth surface (login / signup / forgot / reset /
// verify / check-email). No card — content draws directly on a radial
// parchment gradient. Fraunces display title + ink-soft subtitle + the
// caller's form below. Footer links stack at the bottom.

import type { ReactNode } from 'react';

type AuthShellProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
};

export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <main
      className="auth-shell min-h-screen flex items-center justify-center px-4 py-12"
      style={{
        background:
          'radial-gradient(ellipse at top, #F4EDE0 0%, #EAE1CF 60%, #D9CCAF 100%)',
      }}
    >
      <div className="w-full max-w-[420px]">
        <header className="mb-10 text-center">
          <h1
            className="auth-title text-[44px] leading-[1.05] font-semibold text-[#2A241E]"
            style={{ fontFamily: '"Fraunces", Georgia, serif' }}
          >
            {title}
          </h1>
          <p className="auth-fade mt-3 text-[15px] text-[#5A4F42]">{subtitle}</p>
        </header>

        <section className="auth-fade">{children}</section>

        {footer && (
          <footer className="auth-fade mt-10 text-center text-sm text-[#5A4F42]">
            {footer}
          </footer>
        )}
      </div>
    </main>
  );
}
