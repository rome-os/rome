// Holds a member's entry (./entry.ts) over the event streams routes
// answer with, as each WebSocket holds it over its socket.

import type { MiddlewareHandler } from "hono";
import { type HeldEntry, holdEntry, mayEnter } from "./entry.js";
import { currentSessionActor } from "./session-actor.js";
import type { DashboardAllowList } from "./team.js";

/**
 * Ends an event stream once the member reading it may no longer
 * enter. The guardian's streams pass through, since a guardian's entry never
 * ends, and so do the streams of anyone else, whom the route itself let in.
 */
export function endStreamsOnLostEntry(allowList: DashboardAllowList): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const body = c.res.body;
    if (!body || !c.res.headers.get("Content-Type")?.startsWith("text/event-stream")) return;
    const actor = await currentSessionActor();
    if (actor?.kind !== "visitor" || !(await mayEnter(actor, allowList))) return;
    c.res = new Response(
      whileEntryHolds(body, async () => (await mayEnter(actor, allowList)) !== null),
      c.res,
    );
  };
}

function whileEntryHolds(
  source: ReadableStream<Uint8Array>,
  mayStillEnter: () => Promise<boolean>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let ended = false;
  let entry: HeldEntry | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      entry = holdEntry(mayStillEnter, () => {
        ended = true;
        controller.close();
        void reader.cancel().catch(() => {});
      });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (ended) return;
        if (!done) return controller.enqueue(value);
        entry?.release();
        controller.close();
      } catch (err) {
        if (ended) return;
        entry?.release();
        controller.error(err);
      }
    },
    async cancel(reason) {
      entry?.release();
      await reader.cancel(reason);
    },
  });
}
