// Email delivery via Resend.
//
// The server boots fine without RESEND_API_KEY — sendEmail turns into a
// structured console.log that prints the subject + recipient + body so a
// dev can copy the magic-link out of the terminal. Production deploys are
// expected to set RESEND_API_KEY, RESEND_FROM_EMAIL, and PUBLIC_APP_URL.

import { headers } from 'next/headers';
import { Resend } from 'resend';

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

type SendEmailResult = { ok: true } | { ok: false; error: string };

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  resendClient ??= new Resend(key);
  return resendClient;
}

function fromAddress(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() || 'Compendium <no-reply@example.com>';
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const client = getResend();
  if (!client) {
    // Dev / no-key path — the reset + verify tokens are in the body so
    // the operator can copy the link straight from the terminal.
    console.warn(
      `[email] would-send (no RESEND_API_KEY)\n` +
        `  to:      ${input.to}\n` +
        `  subject: ${input.subject}\n` +
        `  body:    ${input.text}`,
    );
    return { ok: true };
  }

  try {
    const result = await client.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (result.error) {
      console.error('[email] resend error', result.error);
      return { ok: false, error: result.error.message ?? 'send_failed' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] send threw', err);
    return { ok: false, error: err instanceof Error ? err.message : 'send_failed' };
  }
}

export async function publicAppUrl(): Promise<string> {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');

  // Fall back to the forwarded host headers so self-hosted deployments
  // that haven't set PUBLIC_APP_URL still generate real links. Only
  // degrade to localhost when running outside a request (tests, etc).
  try {
    const hdrs = await headers();
    const forwardedHost = hdrs.get('x-forwarded-host') ?? hdrs.get('host');
    const forwardedProto = hdrs.get('x-forwarded-proto') ?? 'https';
    if (forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '');
    }
  } catch {
    // headers() throws outside a request scope — fall through.
  }
  return 'http://localhost:3000';
}

// ── Templates ──────────────────────────────────────────────────────────
// Inline-styled HTML keyed to the parchment palette so the email reads
// the same as the auth surface. Plain-text fallback is required by most
// spam filters.

const PAL = {
  parchment: '#F4EDE0',
  vellum: '#FBF5E8',
  rule: '#D4C7AE',
  ink: '#2A241E',
  inkSoft: '#5A4F42',
  candlelight: '#D4A85A',
} as const;

function layout({
  title,
  subtitle,
  bodyHtml,
  cta,
  url,
}: {
  title: string;
  subtitle: string;
  bodyHtml: string;
  cta: string;
  url: string;
}): string {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:${PAL.parchment};font-family:Georgia,'Fraunces',serif;color:${PAL.ink};">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${PAL.parchment};padding:56px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="460" style="max-width:460px;">
        <tr><td align="center" style="font-family:Georgia,'Fraunces',serif;font-size:34px;line-height:1.15;font-weight:700;letter-spacing:-0.01em;color:${PAL.ink};padding-bottom:14px;">
          ${escapeHtml(title)}
        </td></tr>
        <tr><td align="center" style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:${PAL.inkSoft};padding-bottom:32px;">
          ${escapeHtml(subtitle)}
        </td></tr>
        <tr><td align="center" style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:${PAL.inkSoft};padding-bottom:32px;">
          ${bodyHtml}
        </td></tr>
        <tr><td align="center" style="padding-bottom:36px;">
          <a href="${url}" style="display:inline-block;background:${PAL.ink};color:${PAL.parchment};text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;padding:14px 30px;border-radius:10px;letter-spacing:0.01em;">
            ${escapeHtml(cta)}
          </a>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;border-top:1px solid ${PAL.rule};">
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.55;color:${PAL.inkSoft};opacity:0.75;padding-top:18px;">
            If the button doesn't work, copy this link into your browser:<br>
            <a href="${url}" style="word-break:break-all;color:${PAL.candlelight};text-decoration:none;">${escapeHtml(url)}</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export type EmailPayload = { subject: string; html: string; text: string };

export function buildVerificationEmail({
  displayName,
  url,
}: {
  displayName: string;
  url: string;
}): EmailPayload {
  const subject = 'Verify your Compendium account';
  const subtitle = `Welcome, ${displayName} — one last step before the gates open.`;
  const bodyHtml = `
    Tap the button below (or paste the link) within the next 24 hours to confirm
    the email attached to your account. You'll be signed in on the spot and ready
    to step into the realm.
  `;
  const text = `Welcome, ${displayName}!\n\nConfirm your Compendium account by visiting:\n${url}\n\nThis link expires in 24 hours.`;
  return {
    subject,
    html: layout({ title: 'Begin your adventure', subtitle, bodyHtml, cta: 'Verify my email', url }),
    text,
  };
}

export function buildResetEmail({
  displayName,
  url,
}: {
  displayName: string;
  url: string;
}): EmailPayload {
  const subject = 'Reset your Compendium password';
  const subtitle = `Lost your way, ${displayName}? We'll get you back on the road.`;
  const bodyHtml = `
    Tap the button below to set a new password. The link expires in one hour
    and can only be used once. If you didn't ask for a reset, you can safely
    ignore this message — your account is untouched.
  `;
  const text = `Hi ${displayName},\n\nReset your Compendium password:\n${url}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`;
  return {
    subject,
    html: layout({ title: 'Set a new password', subtitle, bodyHtml, cta: 'Reset password', url }),
    text,
  };
}
