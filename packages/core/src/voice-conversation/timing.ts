// How long each step of one spoken turn took, to see where the wait between
// the guardian's last word and Rome's first goes. Every time is in
// milliseconds after the endpoint, when Rome took the guardian's turn as
// finished. A step the turn never reached is left out. Only numbers: no words
// of the turn or the reply.

/** The steps of a turn, in the order they normally come. */
export type VoiceTurnStep =
  /** The chat took the turn and its agent's turn started. */
  | "sent"
  /** The agent's turn sent its first event. */
  | "agentStarted"
  /** The agent began writing what the guardian hears: its text, or a message it is writing. */
  | "writing"
  /** The first sentence of the reply went to speech. */
  | "firstSentence"
  /** The first audio of the reply went to the client. */
  | "firstAudio"
  /** The first audio of the line saying Rome is looking went to the client. */
  | "lookingAudio";

/** How a turn's reply ended. */
export type VoiceTurnOutcome =
  /** The reply ended and something of it was spoken. */
  | "answered"
  /** The reply ended with nothing to say. */
  | "silent"
  /** The guardian spoke over it, or took a new turn. */
  | "stopped"
  /** The conversation ended first. */
  | "closed"
  /** The chat refused the turn. */
  | "refused";

export interface VoiceTurnTiming {
  outcome: VoiceTurnOutcome;
  /** How long after the last words were recognised the endpoint came, when known. */
  endpointAfterWords?: number;
  steps: Partial<Record<VoiceTurnStep, number>>;
  /** Sentences of the reply that went to speech, the looking line not counted. */
  sentences: number;
}

export interface TurnTimer {
  /** Notes the first time the turn reaches `step`. */
  mark(step: VoiceTurnStep): void;
  /** Counts a sentence of the reply that went to speech. */
  sentence(): void;
  /**
   * Ends the timing with `outcome`, once: later calls return null. A reply
   * that ended with no sentence said is "silent", not "answered".
   */
  finish(outcome: VoiceTurnOutcome): VoiceTurnTiming | null;
}

/** Times a turn whose endpoint is now. `lastWordsAt` is when its last words were recognised. */
export function startTurnTimer(now: () => number, lastWordsAt: number | null): TurnTimer {
  const endpointAt = now();
  const steps: Partial<Record<VoiceTurnStep, number>> = {};
  let sentences = 0;
  let done = false;
  return {
    mark(step) {
      if (done || steps[step] !== undefined) return;
      steps[step] = Math.round(now() - endpointAt);
    },
    sentence() {
      if (!done) sentences++;
    },
    finish(outcome) {
      if (done) return null;
      done = true;
      return {
        outcome: outcome === "answered" && sentences === 0 ? "silent" : outcome,
        ...(lastWordsAt !== null
          ? { endpointAfterWords: Math.round(endpointAt - lastWordsAt) }
          : {}),
        steps,
        sentences,
      };
    },
  };
}
