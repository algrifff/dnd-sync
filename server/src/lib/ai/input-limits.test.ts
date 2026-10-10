import { describe, expect, it } from 'bun:test';
import {
  MAX_CHAT_INPUT_CHARS,
  MAX_CHAT_MESSAGES,
  checkChatMessageBudget,
} from './input-limits';

describe('checkChatMessageBudget', () => {
  it('should allow an empty message list', () => {
    const result = checkChatMessageBudget([]);

    expect(result.ok).toBe(true);
  });

  it('should allow a realistic long conversation under the entry cap', () => {
    const messages = Array.from({ length: 120 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `turn ${i}` }],
    }));

    const result = checkChatMessageBudget(messages);

    expect(result.ok).toBe(true);
  });

  it('should reject a message array exceeding the entry count cap', () => {
    const messages = Array.from({ length: MAX_CHAT_MESSAGES + 1 }, () => ({
      role: 'user',
      content: 'hi',
    }));

    const result = checkChatMessageBudget(messages);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('too_many_messages');
  });

  it('should accept an array right at the entry count cap', () => {
    const messages = Array.from({ length: MAX_CHAT_MESSAGES }, () => ({
      role: 'user',
      content: 'hi',
    }));

    const result = checkChatMessageBudget(messages);

    expect(result.ok).toBe(true);
  });

  it('should reject a small number of messages whose combined size exceeds the char cap', () => {
    const messages = [
      { role: 'user', content: 'a'.repeat(MAX_CHAT_INPUT_CHARS + 1) },
    ];

    const result = checkChatMessageBudget(messages);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('input_too_large');
  });

  it('should fail closed on a value that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = checkChatMessageBudget([circular]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('input_too_large');
  });
});
