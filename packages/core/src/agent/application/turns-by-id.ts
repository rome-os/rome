import type { Turn } from "../domain/turn.js";

/** How long an ended turn stays found, so a reader that comes late still replays it. */
const ENDED_TURN_KEPT_MS = 30_000;

/**
 * The turns a manager's sessions started, and the sessions they opened in
 * turn, found by id. A turn is found from its start until 30 s after it ends.
 */
export interface TurnsById {
  add(turn: Turn): void;
  find(id: string): Turn | undefined;
}

export function createTurnsById(keptMs = ENDED_TURN_KEPT_MS): TurnsById {
  const turns = new Map<string, Turn>();
  return {
    add(turn) {
      turns.set(turn.id, turn);
      void turn.ended().then(() => {
        setTimeout(() => {
          if (turns.get(turn.id) === turn) turns.delete(turn.id);
        }, keptMs).unref?.();
      });
    },
    find: (id) => turns.get(id),
  };
}
