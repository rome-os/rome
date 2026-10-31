import { useSyncExternalStore } from "react";

/**
 * The text block a turn is typing right now: `key` names it (`turnId:blockIx`,
 * or `idle` with no turn), `text` is everything the stream has delivered for it.
 */
export interface LiveText {
  key: string;
  text: string;
}

export interface LiveTextStore {
  get: () => LiveText;
  subscribe: (listener: () => void) => () => void;
  /** The text is shown as it arrives, not typed out. */
  instant?: boolean;
}

const IDLE: LiveText = { key: "idle", text: "" };

/** A store with no live text, for a row that shows none. */
export const EMPTY_LIVE_TEXT: LiveTextStore = {
  get: () => IDLE,
  subscribe: () => () => {},
  instant: true,
};

/** A store that never changes, for a caller that already holds the text and shows it as it is. */
export function staticLiveText(text: string, key = "static"): LiveTextStore {
  const snapshot = { key, text };
  return { get: () => snapshot, subscribe: () => () => {}, instant: true };
}

export interface LiveTextSource extends LiveTextStore {
  /** A turn started: its text begins empty at block 0. */
  open: (turnId: string) => void;
  /** The text of `blockIx` so far. Ignored from a turn that is not open, and from an earlier block. */
  set: (turnId: string, blockIx: number, text: string) => void;
  /** The turn ended: nothing is typing. Ignored from a turn that is not open. */
  close: (turnId: string) => void;
}

/**
 * The live text of one session's running turn, outside React state. The stream
 * delivers it many times a second; held in state, every delivery would render
 * the whole chat, so only the components that show it subscribe.
 */
export function createLiveTextSource(): LiveTextSource {
  const listeners = new Set<() => void>();
  let snapshot = IDLE;
  let turnId: string | null = null;
  let blockIx = 0;

  const publish = (next: LiveText) => {
    if (next.key === snapshot.key && next.text === snapshot.text) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    get: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (id) => {
      if (turnId === id) return;
      turnId = id;
      blockIx = 0;
      publish({ key: `${id}:0`, text: "" });
    },
    set: (id, ix, text) => {
      if (turnId !== id || ix < blockIx) return;
      blockIx = ix;
      publish({ key: `${id}:${ix}`, text });
    },
    close: (id) => {
      if (turnId !== id) return;
      turnId = null;
      blockIx = 0;
      publish(IDLE);
    },
  };
}

/** The live text of `store`; the caller renders again each time it changes. */
export function useLiveText(store: LiveTextStore): LiveText {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
