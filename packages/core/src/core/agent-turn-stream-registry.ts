import type { ConversationRef } from "@rome-os/app-runtime";
import type { StreamAgentMessage } from "./agent-session.js";

export interface ActiveAgentTurnStream {
  sessionId: string;
  turnId: string;
  agentName: string;
  conversation?: ConversationRef;
  initiatorId?: string;
  startedAt: string;
  finished: boolean;
  messages(): readonly StreamAgentMessage[];
  subscribe(listener: (message: StreamAgentMessage) => void): () => void;
  waitForFinish(): Promise<void>;
  /** Present only when the owner can safely interrupt this turn in isolation. */
  interrupt?(reason?: string): Promise<void>;
}

interface MutableAgentTurnStream extends ActiveAgentTurnStream {
  publish(message: StreamAgentMessage): void;
  finish(): void;
}

export interface AgentTurnStreamRegistry {
  register(input: {
    sessionId: string;
    turnId: string;
    agentName: string;
    conversation?: ConversationRef;
    initiatorId?: string;
    interrupt?(reason?: string): Promise<void>;
  }): MutableAgentTurnStream;
  get(turnId: string): ActiveAgentTurnStream | undefined;
  getActiveByConversation(ref: ConversationRef): ActiveAgentTurnStream | undefined;
  listBySession(sessionId: string): ActiveAgentTurnStream[];
}

const FINISHED_STREAM_TTL_MS = 30_000;

function conversationKey(ref: ConversationRef): string {
  return `${ref.connectionId}\u0000${ref.conversationId}`;
}

export function createAgentTurnStreamRegistry(): AgentTurnStreamRegistry {
  const streams = new Map<string, MutableAgentTurnStream>();
  const activeByConversation = new Map<string, MutableAgentTurnStream>();

  return {
    register(input) {
      if (streams.has(input.turnId)) {
        throw new Error(`Turn stream "${input.turnId}" is already registered`);
      }
      const values: StreamAgentMessage[] = [];
      const listeners = new Set<(message: StreamAgentMessage) => void>();
      let resolveFinished!: () => void;
      const finishedPromise = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      const stream: MutableAgentTurnStream = {
        sessionId: input.sessionId,
        turnId: input.turnId,
        agentName: input.agentName,
        conversation: input.conversation,
        initiatorId: input.initiatorId,
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
          if (
            input.conversation &&
            activeByConversation.get(conversationKey(input.conversation)) === stream
          ) {
            activeByConversation.delete(conversationKey(input.conversation));
          }
          resolveFinished();
          setTimeout(() => {
            if (streams.get(input.turnId) === stream) streams.delete(input.turnId);
          }, FINISHED_STREAM_TTL_MS).unref?.();
        },
      };
      streams.set(input.turnId, stream);
      if (input.conversation) {
        activeByConversation.set(conversationKey(input.conversation), stream);
      }
      return stream;
    },

    get(turnId) {
      return streams.get(turnId);
    },

    getActiveByConversation(ref) {
      const stream = activeByConversation.get(conversationKey(ref));
      return stream && !stream.finished ? stream : undefined;
    },

    listBySession(sessionId) {
      return [...streams.values()].filter(
        (stream) => stream.sessionId === sessionId && !stream.finished,
      );
    },
  };
}
