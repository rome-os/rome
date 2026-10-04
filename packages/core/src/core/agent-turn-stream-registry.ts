import type { ConversationRef, StreamAgentEvent } from "@rome-os/app-runtime";

export interface ActiveAgentTurnStream {
  sessionId: string;
  turnId: string;
  agentName: string;
  conversation?: ConversationRef;
  initiatorId?: string;
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
    turnId: string;
    agentName: string;
    conversation?: ConversationRef;
    initiatorId?: string;
    interrupt?(reason?: string): Promise<void>;
  }): MutableAgentTurnStream;
  get(turnId: string): ActiveAgentTurnStream | undefined;
  getActiveByConversation(ref: ConversationRef): ActiveAgentTurnStream | undefined;
  listBySession(sessionId: string): ActiveAgentTurnStream[];
  /** Calls `listener` with the session id whenever one of its turns starts or finishes. */
  onSessionChange(listener: (sessionId: string) => void): () => void;
}

const FINISHED_STREAM_TTL_MS = 30_000;
/**
 * A detached WebChat reader replays this buffer. Command output can be many
 * megabytes, so retain enough to make a reconnect useful without keeping an
 * unbounded copy for the turn's 30-second grace period.
 */
export const MAX_BUFFERED_TOOL_OUTPUT_CHARS = 256 * 1024;
const TRUNCATED_TOOL_OUTPUT_PREFIX = "… earlier output truncated in the live replay …\n";

export function appendBufferedToolOutput(previous: string, next: string): string {
  const output = previous + next;
  if (output.length <= MAX_BUFFERED_TOOL_OUTPUT_CHARS) return output;
  const contentLimit = MAX_BUFFERED_TOOL_OUTPUT_CHARS - TRUNCATED_TOOL_OUTPUT_PREFIX.length;
  return TRUNCATED_TOOL_OUTPUT_PREFIX + output.slice(-contentLimit);
}

function conversationKey(ref: ConversationRef): string {
  return `${ref.connectionId}\u0000${ref.conversationId}`;
}

export function createAgentTurnStreamRegistry(): AgentTurnStreamRegistry {
  const streams = new Map<string, MutableAgentTurnStream>();
  const activeByConversation = new Map<string, MutableAgentTurnStream>();
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
      // The stream retains one accumulated replay delta per running command,
      // while listeners still receive every provider chunk immediately.
      const bufferedToolOutputIndex = new Map<string, number>();
      const listeners = new Set<(message: StreamAgentEvent) => void>();
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
          if (message.type === "tool_output_delta") {
            const priorIndex = bufferedToolOutputIndex.get(message.toolUseId);
            const prior = priorIndex === undefined ? undefined : values[priorIndex];
            if (priorIndex !== undefined && prior?.type === "tool_output_delta") {
              values[priorIndex] = {
                ...prior,
                content: appendBufferedToolOutput(prior.content, message.content),
              };
            } else {
              bufferedToolOutputIndex.set(message.toolUseId, values.length);
              values.push(message);
            }
          } else {
            values.push(message);
            if (message.type === "tool_result") {
              bufferedToolOutputIndex.delete(message.toolUseId);
            }
          }
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
          notifySession(input.sessionId);
          setTimeout(() => {
            if (streams.get(input.turnId) === stream) streams.delete(input.turnId);
          }, FINISHED_STREAM_TTL_MS).unref?.();
        },
      };
      streams.set(input.turnId, stream);
      if (input.conversation) {
        activeByConversation.set(conversationKey(input.conversation), stream);
      }
      notifySession(input.sessionId);
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

    onSessionChange(listener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },
  };
}
