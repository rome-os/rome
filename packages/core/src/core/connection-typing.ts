// A connected chat's typing indicator, shown by the same rule as the
// dashboard's typing dots (core/message-writing.ts): while the agent writes
// a message. On a connection the reply is the turn's text, so it shows while
// that text streams. A platform drops its indicator after a few seconds, so
// it is shown again every RENEW_MS while the writing lasts, and no more once
// it ends. Where the provider cannot say when it writes (a simulated turn),
// the dashboard only holds each message behind its dots for a moment once it
// has arrived; a connection sends the message at once, so it shows nothing.
// A turn no person started, such as a task's report, shows nothing, as a
// quiet turn on the dashboard shows no dots before its first message.

import { createLogger } from "../logger.js";
import { MessageWriting, messageWritingModeOf } from "./message-writing.js";

const log = createLogger("connection-typing");

/** Discord drops its typing indicator after about ten seconds. */
export const RENEW_MS = 8_000;

/** One turn's typing: told each of the turn's events, then its end. */
export interface TurnTyping {
  event(msg: Parameters<MessageWriting["on"]>[0]): void;
  end(): void;
}

/** Where a turn runs and who started it, as the runner knows them. */
export interface TypingTurn {
  channel?: string;
  threadId?: string;
  /** "user" for a turn a message started. */
  initiatedBy?: string;
  /** The provider that runs the turn, read at its first event. */
  providerId: () => string | undefined;
}

export type TurnTypingFor = (turn: TypingTurn) => TurnTyping | null;

export function connectionTyping(deps: {
  /** Shows the typing indicator in a chat of channel `channel`, or null when
   *  the channel shows none. */
  typingOf: (channel: string) => ((chatId: string) => Promise<void>) | null;
  renewMs?: number;
}): TurnTypingFor {
  const renewMs = deps.renewMs ?? RENEW_MS;
  return (turn) => {
    const { channel, threadId } = turn;
    if (!channel || channel === "webchat" || !threadId || turn.initiatedBy !== "user") return null;
    const show = deps.typingOf(channel);
    if (!show) return null;
    let writing: MessageWriting | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      void show(threadId).catch((error: unknown) =>
        log.debug("typing indicator not shown", {
          channel,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    return {
      event(msg) {
        writing ??= new MessageWriting(messageWritingModeOf(turn.providerId()), {
          textIsMessage: true,
        });
        const changed = writing.on(msg);
        if (changed === true && !timer) {
          tick();
          timer = setInterval(tick, renewMs);
          timer.unref?.();
        } else if (changed === false) {
          stop();
        }
      },
      end: stop,
    };
  };
}
