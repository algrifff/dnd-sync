import { describe, expect, it } from 'bun:test';
import { sha256 } from './hash';

describe('sha256', () => {
  it('should hash the empty string to the well-known constant', async () => {
    expect(await sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('should hash "abc" to the RFC-6234 vector', async () => {
    expect(await sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('should produce lower-case hex padded to 64 chars', async () => {
    const hash = await sha256('the quick brown fox');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should produce stable output across calls', async () => {
    const a = await sha256('same content');
    const b = await sha256('same content');
    expect(a).toBe(b);
  });

  it('should differ for different inputs', async () => {
    const a = await sha256('one');
    const b = await sha256('two');
    expect(a).not.toBe(b);
  });

  it('should handle multibyte UTF-8 correctly', async () => {
    // "héllo" — the é is two UTF-8 bytes, so the hash must not match the
    // ASCII-only "hello".
    const accented = await sha256('héllo');
    const ascii = await sha256('hello');
    expect(accented).not.toBe(ascii);
  });
});
