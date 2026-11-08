import type { StreamAgentEvent } from "@rome-os/app-runtime";

export interface ActiveAgentTurnStream {
  sessionId: string;
  /** The conversation (rome session) the turn is recorded in. */
  chatId: string;
  turnId: string;
  agentName: string;
  startedAt: string;
  finished: boolean;
  messages(): readonly StreamAgentEvent[];
  subscribe(listener: (message: StreamAgentEvent) => void): () => void;
  waitForFinish(): Promise<void>;
  /** Present only when the owner can safely interrupt this turn in isolation. */
  interrupt?(reason?: string): Promise<void>;
}

interface MutableAgentTurnStream extends ActiveAgentTurnStream {
  publish(message: StreamAgentEvent): void;
  finish(): void;
}

export interface AgentTurnStreamRegistry {
  register(input: {
    sessionId: string;
    chatId: string;
    turnId: string;
    agentName: string;
    interrupt?(reason?: string): Promise<void>;
  }): MutableAgentTurnStream;
  get(turnId: string): ActiveAgentTurnStream | undefined;
  listBySession(sessionId: string): ActiveAgentTurnStream[];
  /** Calls `listener` with the session id whenever one of its turns starts or finishes. */
  onSessionChange(listener: (sessionId: string) => void): () => void;
}

const FINISHED_STREAM_TTL_MS = 30_000;

export function createAgentTurnStreamRegistry(): AgentTurnStreamRegistry {
  const streams = new Map<string, MutableAgentTurnStream>();
  const sessionListeners = new Set<(sessionId: string) => void>();
  const notifySession = (sessionId: string) => {
    for (const listener of sessionListeners) listener(sessionId);
  };

  return {
    register(input) {
      if (streams.has(input.turnId)) {
        throw new Error(`Turn stream "${input.turnId}" is already registered`);
      }
      const values: StreamAgentEvent[] = [];
      const listeners = new Set<(message: StreamAgentEvent) => void>();
      let resolveFinished!: () => void;
      const finishedPromise = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      const stream: MutableAgentTurnStream = {
        sessionId: input.sessionId,
        chatId: input.chatId,
        turnId: input.turnId,
        agentName: input.agentName,
        startedAt: new Date().toISOString(),
        finished: false,
        messages: () => values,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        waitForFinish: () => finishedPromise,
        interrupt: input.interrupt,
        publish(message) {
          if (stream.finished) return;
          values.push(message);
          for (const listener of listeners) listener(message);
        },
        finish() {
          if (stream.finished) return;
          stream.finished = true;
          resolveFinished();
          notifySession(input.sessionId);
          setTimeout(() => {
            if (streams.get(input.turnId) === stream) streams.delete(input.turnId);
          }, FINISHED_STREAM_TTL_MS).unref?.();
        },
      };
      streams.set(input.turnId, stream);
      notifySession(input.sessionId);
      return stream;
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
