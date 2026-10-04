import { randomUUID } from "node:crypto";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelTurnEvent } from "./agent-runner.js";

// Reads the Claude Agent SDK's turns straight off its stream. The SDK is the
// source of truth: nothing here waits for, pauses on or remembers a send.
//
// - A turn starts with the first piece of the SDK's next turn: a replay of a
//   message it picked up, a top-level model frame, or a result with no frames
//   (the empty result of a resumed background task).
// - It ends with that turn's result.
// - The inputs it answers come from the SDK's echo: `user_message_uuid(s)` on
//   the turn's first frame, on the first frame after a message folds into a
//   turn the SDK started, and the full list on the result. A message folded
//   into a turn Rome started is named only on the result (documented: a
//   typed prompt keeps its uuid for the whole turn).

/** The uuids of the sends a frame or result answers (the SDK's echo). */
export function echoedSendIds(message: {
  user_message_uuid?: string;
  user_message_uuids?: string[];
}): string[] {
  return (
    message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : [])
  );
}

function isTopLevelModelFrame(message: SDKMessage): boolean {
  return (
    (message.type === "assistant" || message.type === "stream_event") &&
    message.parent_tool_use_id === null
  );
}

function isReplay(message: SDKMessage): boolean {
  return message.type === "user" && "isReplay" in message && message.isReplay === true;
}

export class SdkTurnProjection {
  private current: { turnId: string; answers: Set<string>; frameless: boolean } | undefined;

  /** An SDK turn is open: started, and its result not yet seen. */
  get isOpen(): boolean {
    return this.current !== undefined;
  }

  /** The open turn began with its result: no replay or model frame came first. */
  get isFrameless(): boolean {
    return this.current?.frameless === true;
  }

  /** Turn events to emit before handling `message`. */
  before(message: SDKMessage): ModelTurnEvent[] {
    const modelFrame = isTopLevelModelFrame(message);
    const echoed = modelFrame ? echoedSendIds(message as Parameters<typeof echoedSendIds>[0]) : [];
    if (!this.current) {
      if (!modelFrame && !isReplay(message) && message.type !== "result") return [];
      this.current = {
        turnId: randomUUID(),
        answers: new Set(echoed),
        frameless: message.type === "result",
      };
      return [{ type: "model_turn_start", turnId: this.current.turnId, answers: echoed }];
    }
    return this.add(echoed);
  }

  /**
   * Turn events to emit after handling a result: anything it newly names, then
   * the end. `settles` adds inputs the result answers without echoing them
   * (see AnthropicProvider: a result after which the SDK answers nothing).
   */
  end(result: SDKResultMessage, settles: string[] = []): ModelTurnEvent[] {
    const current = this.current;
    if (!current) return [];
    const events = this.add([...echoedSendIds(result), ...settles]);
    events.push({ type: "model_turn_end", turnId: current.turnId, answers: [...current.answers] });
    this.current = undefined;
    return events;
  }

  private add(ids: string[]): ModelTurnEvent[] {
    const current = this.current;
    if (!current) return [];
    const added = ids.filter((id) => !current.answers.has(id));
    if (added.length === 0) return [];
    for (const id of added) current.answers.add(id);
    return [{ type: "model_turn_answers", turnId: current.turnId, added }];
  }
}
