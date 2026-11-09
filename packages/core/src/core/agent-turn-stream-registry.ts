/**
 * A turn that runs outside a web chat stream (an app's, a subagent's or a
 * forked turn) and the chat it is recorded in. The turn itself, its events and
 * its stop, is found by id through the agent session manager.
 */
export interface ActiveAgentTurnStream {
  sessionId: string;
  /** The conversation (rome session) the turn is recorded in. */
  chatId: string;
  turnId: string;
  startedAt: string;
  finished: boolean;
}

/**
 * Which chat each such turn is recorded in, and which run in each session. A
 * turn is kept until 30 s after it finishes.
 */
export interface AgentTurnStreamRegistry {
  register(input: { sessionId: string; chatId: string; turnId: string }): { finish(): void };
  get(turnId: string): ActiveAgentTurnStream | undefined;
  listBySession(sessionId: string): ActiveAgentTurnStream[];
  /** Calls `listener` with the session id whenever one of its turns starts or finishes. */
  onSessionChange(listener: (sessionId: string) => void): () => void;
}

const FINISHED_STREAM_TTL_MS = 30_000;

export function createAgentTurnStreamRegistry(): AgentTurnStreamRegistry {
  const streams = new Map<string, ActiveAgentTurnStream>();
  const sessionListeners = new Set<(sessionId: string) => void>();
  const notifySession = (sessionId: string) => {
    for (const listener of sessionListeners) listener(sessionId);
  };

  return {
    register(input) {
      if (streams.has(input.turnId)) {
        throw new Error(`Turn stream "${input.turnId}" is already registered`);
      }
      const stream: ActiveAgentTurnStream = {
        sessionId: input.sessionId,
        chatId: input.chatId,
        turnId: input.turnId,
        startedAt: new Date().toISOString(),
        finished: false,
      };
      streams.set(input.turnId, stream);
      notifySession(input.sessionId);
      return {
        finish() {
          if (stream.finished) return;
          stream.finished = true;
          notifySession(input.sessionId);
          setTimeout(() => {
            if (streams.get(input.turnId) === stream) streams.delete(input.turnId);
          }, FINISHED_STREAM_TTL_MS).unref?.();
        },
      };
    },

    get(turnId) {
      return streams.get(turnId);
    },

    listBySession(sessionId) {
      return [...streams.values()].filter(
        (stream) => stream.sessionId === sessionId && !stream.finished,
      );
    },

    onSessionChange(listener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },
  };
}
