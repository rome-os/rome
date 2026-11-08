// What a forked turn opens with, decided from its source. The words are in
// docs/concepts/sessions.md (Forked turns).

import type { ForkRunMode, ForkSourceCheckpoint, ThreadContext } from "@rome-os/app-runtime";
import type { ModelPosition, ModelThreadId, ProviderId } from "./model-port.js";

/** The source session, as a fork reads it when it opens. */
export interface ForkSource {
  providerId: ProviderId;
  /** The model thread the source's model session is on, when the provider has named it. */
  modelThreadId?: ModelThreadId;
  /** Where the source's last completed turn left its model thread. */
  lastPosition?: ModelPosition;
  threadContext?: ThreadContext;
}

/** What the caller of a fork asks for. */
export interface ForkRequest {
  /** Defaults to `"isolated"`. */
  mode?: ForkRunMode;
  /** The turn to branch from. Without one, the fork branches from the source's last completed turn. */
  checkpoint?: ForkSourceCheckpoint;
  /** The thread context the fork's actions carry. Without one, the source's. */
  threadContext?: ThreadContext;
  /** The continuity key a continuable fork is kept under, from its session id. Absent for a one-shot fork. */
  continuityKey?: (forkSessionId: string) => string;
}

/**
 * What a forked turn opens with. A one-shot fork's model thread is closed
 * after its turn, and nothing can resume it. A continuable fork is kept under
 * its continuity key.
 */
export type ForkOpening = {
  /** Which tools the fork has: none when isolated, its source's when exact (`forkSessionTools`). */
  mode: ForkRunMode;
  /** Where the turn the fork branches from left the source's model thread. */
  sourceTurn: ModelPosition;
  threadContext?: ThreadContext;
} & ({ oneShot: true } | { oneShot: false; continuityKey: string });

/**
 * What the fork of `source` opens with. Throws when the source cannot be
 * forked as asked: the checkpoint is another provider's or another model
 * thread's, or no turn has left one.
 */
export function openFork(
  source: ForkSource,
  request: ForkRequest,
  forkSessionId: string,
): ForkOpening {
  const { checkpoint } = request;
  if (checkpoint && checkpoint.providerId !== source.providerId) {
    throw new Error(
      `Fork checkpoint provider ${checkpoint.providerId} does not match live provider ${source.providerId}`,
    );
  }
  const at: ModelPosition | undefined = checkpoint
    ? {
        provider: source.providerId,
        modelThreadId: checkpoint.providerThreadId,
        checkpointId: checkpoint.checkpointId,
      }
    : source.lastPosition;
  if (!at) throw new Error("Cannot fork before a turn has left a checkpoint");
  if (source.modelThreadId && at.modelThreadId !== source.modelThreadId) {
    throw new Error("Fork checkpoint belongs to a different model thread");
  }
  const continuityKey = request.continuityKey?.(forkSessionId);
  return {
    mode: request.mode ?? "isolated",
    sourceTurn: at,
    threadContext: request.threadContext ?? source.threadContext,
    ...(continuityKey === undefined ? { oneShot: true } : { oneShot: false, continuityKey }),
  };
}

/**
 * Whether a forked turn leaves a fork the guardian can keep talking to: it was
 * asked to be continuable, it completed, and it ran on a model thread of its
 * own. A provider that ran the branch inside the source thread rolled it back
 * out, and keeping it would add every later turn to the source.
 */
export function keepsFork(
  opening: ForkOpening,
  ran: { completed: boolean; modelThreadId?: ModelThreadId; sourceModelThreadId?: ModelThreadId },
): boolean {
  return !opening.oneShot && ran.completed && ran.modelThreadId !== ran.sourceModelThreadId;
}
