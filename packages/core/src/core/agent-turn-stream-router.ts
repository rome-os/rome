import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { IpcRpc } from "../actions/ipc.js";

export interface AgentTurnStreamSink {
  push(message: StreamAgentEvent): void;
  end(error?: Error): void;
}

interface TurnEntry {
  values: StreamAgentEvent[];
  done: boolean;
  error?: Error;
  sink?: AgentTurnStreamSink;
  /** Consumer released the turn; drop any further events. */
  discarded: boolean;
  /** GC timer for entries that are never claimed (e.g. runTurn RPC failed). */
  cleanup?: NodeJS.Timeout;
}

const UNCLAIMED_ENTRY_TTL_MS = 5 * 60_000;

/**
 * Routes the `agent.turn:<turnId>` streams arriving on one parent IPC link.
 *
 * Main opens the stream before resolving `agent.session.runTurn`, so a stream
 * can start before its consumer knows the turn id. Keeping one shared router
 * per IpcRpc lets concurrent and sequential RpcAgentRunner calls buffer, then
 * claim, their exact stream without competing catch-all handlers.
 */
export class AgentTurnStreamRouter {
  private entries = new Map<string, TurnEntry>();

  constructor(ipc: IpcRpc) {
    ipc.onStream<StreamAgentEvent>(/^agent\.turn:/, async (stream) => {
      const entry = this.entryFor(stream.name);
      try {
        for await (const message of stream.iter()) {
          if (entry.discarded) continue;
          if (entry.sink) {
            entry.sink.push(message);
          } else {
            entry.values.push(message);
          }
        }
      } catch (err) {
        entry.error = err instanceof Error ? err : new Error(String(err));
      }
      entry.done = true;
      if (entry.sink) {
        entry.sink.end(entry.error);
        this.drop(stream.name, entry);
      }
      // Unclaimed entries stay buffered until claimed or until the TTL fires.
    });
  }

  /** Attach the consumer for a turn, flushing anything buffered so far. */
  claim(name: string, sink: AgentTurnStreamSink): void {
    const entry = this.entryFor(name);
    entry.sink = sink;
    for (const value of entry.values) sink.push(value);
    entry.values = [];
    if (entry.done) {
      sink.end(entry.error);
      this.drop(name, entry);
    }
  }

  /** Detach the consumer (it finished or aborted); discard further events. */
  release(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.sink = undefined;
    entry.discarded = true;
    if (entry.done) this.drop(name, entry);
  }

  private entryFor(name: string): TurnEntry {
    let entry = this.entries.get(name);
    if (!entry) {
      const created: TurnEntry = { values: [], done: false, discarded: false };
      this.entries.set(name, created);
      created.cleanup = setTimeout(() => {
        if (!created.sink) this.entries.delete(name);
      }, UNCLAIMED_ENTRY_TTL_MS);
      created.cleanup.unref?.();
      entry = created;
    }
    return entry;
  }

  private drop(name: string, entry: TurnEntry): void {
    if (entry.cleanup) clearTimeout(entry.cleanup);
    this.entries.delete(name);
  }
}

const routers = new WeakMap<IpcRpc, AgentTurnStreamRouter>();

export function agentTurnStreamRouterFor(ipc: IpcRpc): AgentTurnStreamRouter {
  let router = routers.get(ipc);
  if (!router) {
    router = new AgentTurnStreamRouter(ipc);
    routers.set(ipc, router);
  }
  return router;
}
