// Fake ports for the voice input tests.

import type { Dictation, DictationHandlers } from "@/lib/voice-input/dictation";
import type { PageEvents, TextEditor } from "./voice-input";

/** A field held in memory. `focusable` false stands in for a hidden field. */
export function fakeEditor(value = "", start = value.length, end = start) {
  const field = {
    value,
    start,
    end,
    focusable: true,
    /** Each native insert, as an undo step. */
    inserts: [] as string[],
    /** `ownEdit` as seen during each insert. */
    onInsert: () => {},
    shown: null as (() => void) | null,
    waitsCancelled: 0,
  };
  const editor: TextEditor = {
    read: () => ({ value: field.value, start: field.start, end: field.end }),
    write: (next) => {
      field.value = next;
    },
    select: (from, to) => {
      field.start = from;
      field.end = to;
      return field.focusable;
    },
    insert: (text) => {
      field.onInsert();
      field.value = field.value.slice(0, field.start) + text + field.value.slice(field.end);
      field.start = field.end = field.start + text.length;
      field.inserts.push(text);
      return true;
    },
    whenShown: (shown) => {
      field.shown = shown;
      return () => {
        field.shown = null;
        field.waitsCancelled += 1;
      };
    },
  };
  return { field, editor };
}

/** A transcriber that records each dictation and lets the test answer as Rome would. */
export function fakeTranscriber() {
  const dictations: Array<{
    handlers: DictationHandlers;
    stopped: number;
    cancelled: number;
  }> = [];
  const transcriber = (handlers: DictationHandlers): Dictation => {
    const entry = { handlers, stopped: 0, cancelled: 0 };
    dictations.push(entry);
    return {
      stop: () => {
        entry.stopped += 1;
      },
      cancel: () => {
        entry.cancelled += 1;
      },
    };
  };
  return { transcriber, dictations, last: () => dictations[dictations.length - 1] };
}

export function fakePage() {
  const listeners = new Set<() => void>();
  const page: PageEvents = {
    onHide: (hidden) => {
      listeners.add(hidden);
      return () => listeners.delete(hidden);
    },
  };
  return { page, hide: () => listeners.forEach((hidden) => hidden()), listeners };
}
