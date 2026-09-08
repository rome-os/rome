// The one thing Rome renders whenever it shows what was said: a line, which way
// it went, when it was said, and a stable id for it. That is a message
// (docs/concepts/messaging.md#message).
//
// It lives on its own, not inside any one surface's contract, because more than
// one surface reads it. A person's timeline pages messages, and a conversation
// on a channel answers what it holds with the same shape — and a conversation
// is not a person's timeline. The shape, the order it is read in, and the
// cursor that names a position in it are stated once, here, so no reader has to
// import a surface it has nothing to do with to say "message".

/**
 * One message: a line, whichever surface produced it.
 *
 * Deliberately generic: `source` names the producer, `ref` is that producer's
 * own id for the message, and `body` is the line to render. A Rome App that
 * starts contributing messages fills the same five fields instead of extending
 * this shape.
 *
 * `ref` must be unique across everything one `source` can put on one timeline,
 * not merely within the conversation it came from. A person holds several
 * accounts, and a producer whose ids are per-conversation (WhatsApp message ids
 * are unique within a chat, not within an account) has to qualify them —
 * `<chat>:<messageId>` — before writing them here. {@link compareMessages}
 * settles ties on `(source, ref)`, so two messages sharing one within the same
 * second compare equal, serialize to the same cursor, and lose one of the pair
 * on resume.
 */
export interface Message {
  source: string;
  /** Epoch seconds. */
  timestamp: number;
  body: string | null;
  direction: "inbound" | "outbound";
  ref: string;
}

/**
 * Compare two strings by code point, returning zero only for exact equality.
 *
 * `localeCompare` answers zero for strings that are canonically equivalent but
 * distinct — "é" and "é" — and its result depends on the running
 * locale, so a server and a client can disagree on the same pair. Neither is
 * acceptable where an order has to be total and has to mean the same thing on
 * both ends of a cursor.
 *
 * It lives here because the message order is the leaf both a store and a
 * person's timeline read through. The People contract re-exports it for the
 * account and display-name orders, which settle their own ties the same way, so
 * "how two strings order for a cursor" has one definition rather than two that
 * can drift.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * A message order: newest first, and total.
 *
 * Producers share no key but the timestamp, and timestamps collide — whole
 * seconds from two stores, and a reply Rome sent recorded against the message
 * it answers. So the order is settled past the timestamp: a reply sits above
 * the line it answers, and `source`/`ref` break what remains. Totality is not
 * cosmetic — it is what lets a cursor name a position and resume there without
 * repeating or skipping a message.
 *
 * The `source`/`ref` ties break through {@link compareCodePoints} — the same
 * total string order the account and display-name orders use — so a cursor
 * written on one end resumes at the same position on the other.
 */
export function compareMessages(a: Message, b: Message): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  if (a.direction !== b.direction) return a.direction === "outbound" ? -1 : 1;
  if (a.source !== b.source) return compareCodePoints(a.source, b.source);
  return compareCodePoints(a.ref, b.ref);
}

/**
 * A cursor naming the exact message a page ended on.
 *
 * Encoded rather than a bare timestamp: the timestamp alone cannot say *which*
 * of a second's messages was the last one sent, so resuming from it drops the
 * rest of that second.
 *
 * Every part is escaped. `source` is whatever a producer calls itself and a
 * Rome App names its own, so neither it nor `ref` can be trusted to leave the
 * separator alone — an unescaped one shifts the split and resumes the page at
 * a position no message occupies.
 */
export function messageCursor(message: Message): string {
  return [message.timestamp, message.direction, message.source, message.ref]
    .map((part) => encodeURIComponent(String(part)))
    .join("|");
}

/** Decode a {@link messageCursor}, or null when it is not one. */
export function parseMessageCursor(raw: string | undefined | null): Message | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 4) return null;
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const [rawTimestamp, direction, source, ref] = decoded;
  const timestamp = Number(rawTimestamp);
  if (rawTimestamp === "" || !Number.isFinite(timestamp)) return null;
  if (direction !== "inbound" && direction !== "outbound") return null;
  if (!ref) return null;
  return { timestamp, direction, source, ref, body: null };
}

/** Whether a message falls after a cursor in {@link compareMessages} order —
 *  i.e. belongs on a later page than the one that cursor ended. */
export function isAfterMessageCursor(message: Message, cursor: Message): boolean {
  return compareMessages(cursor, message) < 0;
}
