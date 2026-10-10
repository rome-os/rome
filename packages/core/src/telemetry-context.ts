import { AsyncLocalStorage } from "node:async_hooks";

// Session context propagation
//
// A session's id should flow through every span, log, and metric emitted
// while the session is running. We carry it in an AsyncLocalStorage so that
// callers (logger, tracer, anything under the agent runner) can pull it
// without every function threading it through as an argument.
//
// Known limitation (accepted for v1): this context does NOT
// cross `child_process.fork()` boundaries. Action workers emit spans and
// logs without session.id; those appear as orphan records. Follow-up is
// tracked in the impl plan; a fix would serialize session.id over the IPC
// channel at fork time and re-install it at worker entry.

export interface SessionContext {
  sessionId: string;
}

const store = new AsyncLocalStorage<SessionContext>();

export function currentSessionId(): string | undefined {
  return store.getStore()?.sessionId;
}

/**
 * Bind the rest of the *current* async chain to `sessionId`. Subsequent
 * awaits, timers, and generator resumptions within the same async function
 * inherit the context.
 *
 * Caveat: `enterSession` does NOT reliably survive generator `yield`
 * boundaries when the yielded generator is driven from an outer scope that
 * itself sets a different session. In practice this means: after a nested
 * agent run (subagent) yields, the parent may observe the child's session
 * id on subsequent logs/spans until the parent's next own internal work.
 * For robust bracketing use `withSessionIterable`.
 */
export function enterSession(sessionId: string): void {
  store.enterWith({ sessionId });
}

/**
 * Run `fn` inside a fresh session context. Prefer this over `enterSession`
 * when the caller genuinely brackets the work (e.g., one handler invocation)
 * rather than "set once and let the generator run."
 */
export function runWithSession<T>(sessionId: string, fn: () => T): T {
  return store.run({ sessionId }, fn);
}

/**
 * Drive an async iterable so that **every** `.next()` call runs inside the
 * session context. Use this to wrap an inner generator whose body should
 * observe `sessionId`, even if a nested call (e.g., a subagent) has entered
 * a different session in between yields. The yielded values reach the
 * caller in whatever context the caller is using — we only bind the
 * iterator's own execution.
 */
export async function* withSessionIterable<T>(
  sessionId: string,
  factory: () => AsyncIterable<T>,
): AsyncGenerator<T, void, void> {
  const iter = store.run({ sessionId }, () => factory()[Symbol.asyncIterator]());
  try {
    while (true) {
      const { value, done } = await store.run({ sessionId }, () => iter.next());
      if (done) return;
      yield value;
    }
  } finally {
    await iter.return?.();
  }
}
