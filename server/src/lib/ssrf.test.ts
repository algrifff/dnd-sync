import { describe, expect, it } from 'bun:test';
import { createGuardedFetch, isPublicAddress } from './ssrf';

describe('isPublicAddress', () => {
  it('accepts ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '160.79.104.5', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(ip)).toBe(true);
    }
  });

  it('rejects loopback, private, link-local, CGNAT and unspecified IPv4', () => {
    for (const ip of [
      '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it('rejects loopback, unique-local, link-local and unspecified IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1']) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it('rejects IPv4 hidden inside IPv6 forms', () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '::127.0.0.1']) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('rejects anything that is not an IP literal', () => {
    expect(isPublicAddress('localhost')).toBe(false);
    expect(isPublicAddress('999.1.1.1')).toBe(false);
  });
});

describe('createGuardedFetch', () => {
  const inner = () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return new Response('ok');
    };
    return { calls, fetcher };
  };

  it('refuses a host that resolves to the cloud metadata address without connecting', async () => {
    const { calls, fetcher } = inner();
    const guarded = createGuardedFetch(async () => [{ address: '169.254.169.254' }], fetcher);
    await expect(guarded('https://metadata.evil.test/c.json', {})).rejects.toThrow(/non-public/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a host when any one of its addresses is private', async () => {
    const { calls, fetcher } = inner();
    const guarded = createGuardedFetch(async () => [{ address: '8.8.8.8' }, { address: '10.0.0.5' }], fetcher);
    await expect(guarded('https://mixed.evil.test/c.json', {})).rejects.toThrow(/non-public/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an IP-literal client_id host', async () => {
    const { calls, fetcher } = inner();
    const guarded = createGuardedFetch(async (host) => [{ address: host }], fetcher);
    await expect(guarded('https://[::1]/c.json', {})).rejects.toThrow(/non-public/);
    await expect(guarded('https://127.0.0.1/c.json', {})).rejects.toThrow(/non-public/);
    expect(calls).toHaveLength(0);
  });

  it('fetches a host whose addresses are all public', async () => {
    const { calls, fetcher } = inner();
    const guarded = createGuardedFetch(async () => [{ address: '8.8.8.8' }], fetcher);
    expect(await (await guarded('https://ok.test/c.json', {})).text()).toBe('ok');
    expect(calls).toEqual(['https://ok.test/c.json']);
  });
});
