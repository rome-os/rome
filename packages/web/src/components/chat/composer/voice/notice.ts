import type { DictationStop } from "@/lib/voice-input/dictation";
import type { BehaviorContext } from "./behavior";

/** The field's draft, which owns the notice so that it outlives the field. */
export interface NoticeDraft {
  set(stop: DictationStop | null): void;
  /** Saves `stop` with the draft at once, for a field that may be going away. */
  keep(stop: DictationStop): void;
}

/**
 * Shows why listening stopped until the next edit or send. An edit that
 * `ownEdit` claims, such as the spoken text going in, is not the guardian's
 * and leaves the notice.
 */
export function createNotice<State>(
  _context: BehaviorContext<State>,
  options: { draft: NoticeDraft; ownEdit: () => boolean },
) {
  const { draft } = options;
  return {
    show(stop: DictationStop | null) {
      draft.set(stop);
      if (stop) draft.keep(stop);
    },
    clear() {
      draft.set(null);
    },
    /** Call from the field's change handler. */
    edited() {
      if (!options.ownEdit()) draft.set(null);
    },
  };
}
