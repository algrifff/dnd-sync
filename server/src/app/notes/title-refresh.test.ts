import { describe, expect, it } from 'bun:test';
import {
  COMMIT_REFRESH_DELAY_MS,
  TYPING_REFRESH_DELAY_MS,
  createTitleRefresh,
} from './title-refresh';

// Manual clock: timers fire only when the test advances time.
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        timers.set(id, { at: now + ms, fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clear: (h: ReturnType<typeof setTimeout>) => {
        timers.delete(h as unknown as number);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

function setup() {
  const clock = fakeClock();
  let broadcasts = 0;
  const refresh = createTitleRefresh(() => broadcasts++, clock.timers);
  return { clock, refresh, broadcasts: () => broadcasts };
}

describe('createTitleRefresh', () => {
  it('should refresh once after typing pauses', () => {
    const { clock, refresh, broadcasts } = setup();

    refresh.edited();
    clock.advance(1000);
    refresh.edited();
    clock.advance(TYPING_REFRESH_DELAY_MS);

    expect(broadcasts()).toBe(1);
  });

  it('should pull a pending refresh forward when the edit is committed', () => {
    const { clock, refresh, broadcasts } = setup();

    refresh.edited();
    refresh.committed();
    clock.advance(COMMIT_REFRESH_DELAY_MS);

    expect(broadcasts()).toBe(1);
  });

  it('should still refresh once when blur is followed by unmount', () => {
    // Clicking another note in the sidebar blurs the field, then the
    // navigation unmounts the editor, which calls committed() again.
    const { clock, refresh, broadcasts } = setup();

    refresh.edited();
    refresh.committed();
    clock.advance(100);
    refresh.committed();
    clock.advance(TYPING_REFRESH_DELAY_MS);

    expect(broadcasts()).toBe(1);
  });

  it('should not refresh on commit when nothing was edited', () => {
    const { clock, refresh, broadcasts } = setup();

    refresh.committed();
    clock.advance(TYPING_REFRESH_DELAY_MS);

    expect(broadcasts()).toBe(0);
  });
});
