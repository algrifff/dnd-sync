import { describe, expect, it } from 'bun:test';
import { clientIp } from './oauth-http';

describe('clientIp', () => {
  it('trusts the entry the proxy appended, not the one the caller claimed', () => {
    const headers = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });

    expect(clientIp(headers)).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip, then unknown', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});
