import type { SessionTurnFeedbackResponse, TurnFeedback } from "@rome/api-types/trace-segments";

/**
 * Each chat's turn feedback, read once per tab: one request answers every turn
 * of the chat, so a transcript does not ask once per turn as it scrolls in.
 * Feedback is write-once, and a submit here goes into the cached record.
 */
const loaded = new Map<string, Promise<Record<string, TurnFeedback>>>();

/** Every turn's feedback in chat `sessionId`, by turn id. A failed read is not kept, so the next one asks again. */
export function sessionTurnFeedback(sessionId: string): Promise<Record<string, TurnFeedback>> {
  let pending = loaded.get(sessionId);
  if (!pending) {
    pending = fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/feedback`, {
      credentials: "include",
      cache: "no-store",
    }).then(async (res) => {
      if (!res.ok) throw new Error(`feedback read failed: ${res.status}`);
      return ((await res.json()) as SessionTurnFeedbackResponse).feedback;
    });
    loaded.set(sessionId, pending);
    pending.catch(() => {
      if (loaded.get(sessionId) === pending) loaded.delete(sessionId);
    });
  }
  return pending;
}

/** Keeps a record the server answered for a submit, so a remount shows it without asking. */
export function rememberTurnFeedback(sessionId: string, turnId: string, feedback: TurnFeedback) {
  const pending = loaded.get(sessionId);
  if (!pending) return;
  loaded.set(
    sessionId,
    pending.then((all) => ({ ...all, [turnId]: feedback })).catch(() => ({ [turnId]: feedback })),
  );
}

/** For tests: forget every chat's feedback. */
export function resetTurnFeedbackForTest() {
  loaded.clear();
}
