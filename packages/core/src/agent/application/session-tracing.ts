import type { Attributes, Span } from "@opentelemetry/api";

/**
 * Port. Ties a session's traces and logs to the session it runs: spans it
 * starts carry the current session id, and work bound to a session logs
 * under its id. The turn's own spans and the context that nests them stay on
 * `@opentelemetry/api`.
 */
export interface SessionTracing {
  /** A detached span stamped with the current session id; the caller ends it. */
  startSpan(name: string, attrs?: Attributes): Span;
  /** Run `fn` in an active span stamped with the current session id. The span
   *  records a thrown error and ends when `fn` settles. */
  withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T>;
  /** Bind the rest of the current async chain to session `sessionId`. */
  enterSession(sessionId: string): void;
}
