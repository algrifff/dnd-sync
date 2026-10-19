// When a title edit should refresh the sidebar. Typing waits until the
// user pauses; finishing the edit (blur, Enter, or leaving the note)
// pulls a pending refresh forward. Hocuspocus stores 200 ms after the
// last keystroke (maxDebounce 1.5 s), so both delays land after the
// DB write.

export const TYPING_REFRESH_DELAY_MS = 2500;
export const COMMIT_REFRESH_DELAY_MS = 500;

type Timers = {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
};

export type TitleRefresh = {
  edited: () => void;
  /** Also called on unmount: navigating away by clicking the sidebar
   *  is the usual way out of the field, so the refresh must outlive
   *  the editor rather than be cancelled with it. */
  committed: () => void;
};

export function createTitleRefresh(
  broadcast: () => void,
  timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
): TitleRefresh {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay: number): void => {
    if (pending !== null) timers.clear(pending);
    pending = timers.set(() => {
      pending = null;
      broadcast();
    }, delay);
  };
  return {
    edited: () => schedule(TYPING_REFRESH_DELAY_MS),
    committed: () => {
      if (pending !== null) schedule(COMMIT_REFRESH_DELAY_MS);
    },
  };
}
