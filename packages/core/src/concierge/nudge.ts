import type { AgentTurnStatus } from "@rome-os/app-runtime";

/**
 * The private text Concierge ends each turn with. A response with no text at
 * all makes the Claude CLI ask the model for visible output, which repeats the
 * last `say`, so a turn always ends on this word instead.
 */
export const END_OF_TURN_MARKER = "done";

/** The system input of a reminder turn. */
export const NUDGE_PROMPT =
  "<reminder>Your last turn ended with text outside say, so the guardian never saw it. " +
  "If that text was meant for the guardian, send it now with say. " +
  `If it was a note to yourself, end this turn by writing only ${END_OF_TURN_MARKER}.</reminder>`;

/**
 * Whether a finished Concierge turn gets one reminder turn: it completed and
 * its final text is not the end-of-turn marker, whether or not it spoke
 * before. A turn that ends on the marker or on no text is done or a deliberate
 * silence. An interrupted turn (including one a new message superseded) gets
 * none, and neither does a turn while a reminder runs.
 */
export function shouldNudge(turn: {
  status: AgentTurnStatus;
  text: string;
  reminderRunning: boolean;
}): boolean {
  return turn.status === "completed" && !isEndOfTurnMarker(turn.text) && !turn.reminderRunning;
}

// Models sometimes wrap or punctuate the marker ("Done.", "`done`").
function isEndOfTurnMarker(text: string): boolean {
  const word = text
    .trim()
    .toLowerCase()
    .replace(/[`*_.!]/g, "");
  return word === "" || word === END_OF_TURN_MARKER;
}
