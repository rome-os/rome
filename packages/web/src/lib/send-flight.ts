// Hands the composer's on-screen text box to the transcript bubble that renders
// the same input, so the bubble can rise out of the composer into its slot.
//
// The record is keyed by the turn's `inputId`, which the server keeps as the
// user message id. It is a viewport snapshot taken at send time, not a live
// element: on a draft send the composer unmounts before the bubble mounts.

export interface SendOrigin {
  /** Viewport x of the right edge of the composer's text box. */
  right: number;
  /** Viewport y of the bottom edge of the composer's text box. */
  bottom: number;
}

// An upload keeps the text on screen until the server accepts the turn, so the
// window covers a slow upload. A bubble that mounts later than this appears in
// place, because the text it would rise from is long gone.
const ORIGIN_TTL_MS = 15_000;

const origins = new Map<string, { origin: SendOrigin; at: number }>();

/** Records where the textarea's text box sits on screen, for `inputId`. */
export function recordSendOrigin(inputId: string, textarea: HTMLElement): void {
  const rect = textarea.getBoundingClientRect();
  const style = window.getComputedStyle(textarea);
  origins.set(inputId, {
    origin: {
      right: rect.right - (Number.parseFloat(style.paddingRight) || 0),
      bottom: rect.bottom - (Number.parseFloat(style.paddingBottom) || 0),
    },
    at: performance.now(),
  });
}

/**
 * Returns the origin recorded for `inputId` and forgets it, so a bubble flies
 * once. Returns null when nothing was recorded or the record has expired.
 */
export function takeSendOrigin(inputId: string): SendOrigin | null {
  const entry = origins.get(inputId);
  if (!entry) return null;
  origins.delete(inputId);
  return performance.now() - entry.at <= ORIGIN_TTL_MS ? entry.origin : null;
}

/** Forgets the origin for `inputId`, for a send that failed. */
export function discardSendOrigin(inputId: string): void {
  origins.delete(inputId);
}
