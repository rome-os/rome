import { randomUUID } from "node:crypto";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

// SPIKE (t-8e1a6e90, do not merge): Rome's turns follow the SDK's turns.
//
// The SDK's stream is the source of truth. A turn starts with the first piece
// of the SDK's next turn (a replay of a message it picked up, a top-level model
// frame, or a frameless result) and ends with that turn's result. The SDK's
// echo (user_message_uuid(s) on the first frame, on the frame after a fold, and
// the full list on the result) says which sends the turn answers. Nothing here
// waits, pauses or remembers a send: callers hold their own ids.

/** Turn boundaries, yielded inline in the provider's event stream. */
export type SdkTurnEvent =
  | {
      type: "sdk_turn_start";
      turnId: string;
      /** Sends the turn answers so far (from the first frame's echo). */
      answers: string[];
      startedBy: "replay" | "frame" | "result";
    }
  | { type: "sdk_turn_answers"; turnId: string; added: string[] }
  | {
      type: "sdk_turn_end";
      turnId: string;
      /** Every send the turn answered: frame echoes plus the result's list. */
      answers: string[];
      subtype: string;
    };

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

export class SdkTurnProjection {
  private current: { turnId: string; answers: Set<string> } | undefined;

  get currentTurnId(): string | undefined {
    return this.current?.turnId;
  }

  /** Events to yield before handling `message`. */
  before(message: SDKMessage): SdkTurnEvent[] {
    const replay = message.type === "user" && "isReplay" in message && message.isReplay;
    const modelFrame = isTopLevelModelFrame(message);
    if (!this.current) {
      if (!replay && !modelFrame && message.type !== "result") return [];
      const echoed = modelFrame ? echoedSendIds(message as never) : [];
      this.current = { turnId: randomUUID(), answers: new Set(echoed) };
      return [
        {
          type: "sdk_turn_start",
          turnId: this.current.turnId,
          answers: echoed,
          startedBy: replay ? "replay" : modelFrame ? "frame" : "result",
        },
      ];
    }
    if (!modelFrame) return [];
    return this.add(echoedSendIds(message as never));
  }

  /** Events to yield after handling a result: the turn's end. */
  end(result: SDKResultMessage): SdkTurnEvent[] {
    if (!this.current) return [];
    const events = this.add(echoedSendIds(result));
    events.push({
      type: "sdk_turn_end",
      turnId: this.current.turnId,
      answers: [...this.current.answers],
      subtype: result.subtype,
    });
    this.current = undefined;
    return events;
  }

  private add(ids: string[]): SdkTurnEvent[] {
    const current = this.current;
    if (!current) return [];
    const added = ids.filter((id) => !current.answers.has(id));
    for (const id of added) current.answers.add(id);
    return added.length > 0 ? [{ type: "sdk_turn_answers", turnId: current.turnId, added }] : [];
  }
}
