import { randomUUID } from "node:crypto";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

// Decides which Rome turn, if any, gets each message of the Claude Agent SDK
// stream. Every Rome send carries a uuid and origin {kind:"human"}. The SDK
// echoes a send's uuid on the first top-level frame of the turn that answers
// it, and a turn it starts by itself (a finished background task) echoes none.
// That echo is the only ownership signal used.
//
// Rules:
// - A turn whose first top-level frame echoes one of Rome's sends is Rome's,
//   and so is a turn a Rome send is folded into, from the frame that echoes it.
//   Any other turn is the SDK's own: its frames are skipped.
// - A result ends the open Rome turn unless it is the SDK's own: no Rome send
//   echoed, and either its frames went to the SDK or it has no frames and its
//   origin is task-notification.
// - Output for a Rome send with no Rome turn open waits for Rome to open one,
//   but only while a carried steer is queued for adoption, so a turn is
//   coming. Any turn that opens ends the wait, since Rome's turns open in
//   order and the adopting turn may sit behind another caller's. Without a
//   queued steer no turn is coming, so the reply is dropped as the SDK's own
//   instead of holding the stream.
// - A send is forgotten once a result closes the SDK turn that answered it,
//   that is, the result or a frame echoed it. A replay alone answers nothing:
//   the SDK can replay a send in one turn and answer it in the next. A Rome
//   result with no answered send at all (a frameless SDK error) answers the
//   turn's own send.

/** What to do with one SDK message. */
export interface FrameDecision {
  /** "deliver": handle it as Rome output. "skip": a turn the SDK owns. */
  action: "deliver" | "skip";
  /** Wait for Rome to open a turn first; the send this output answers. */
  waitForTurn?: string;
  /** A replayed Rome send to report as consumed. */
  consumed?: string;
  /** A Rome send whose reply is dropped: no Rome turn is open or coming. */
  dropped?: string;
}

/** What a result ends. */
export interface ResultDecision {
  /** "rome": ends the open Rome turn. "sdk": the SDK's own; no Rome terminal. */
  owner: "rome" | "sdk";
  /** Steers the SDK carried past this result, now queued for a new Rome turn. */
  carried: string[];
}

/** The uuids of the sends a frame or result answers (the SDK's echo). */
export function echoedSendIds(message: {
  user_message_uuid?: string;
  user_message_uuids?: string[];
}): string[] {
  return (
    message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : [])
  );
}

function isModelFrame(
  message: SDKMessage,
): message is SDKAssistantMessage | SDKPartialAssistantMessage {
  return (
    (message.type === "assistant" || message.type === "stream_event") &&
    message.parent_tool_use_id === null
  );
}

function isTurnFrame(message: SDKMessage): boolean {
  return message.type === "assistant" || message.type === "stream_event" || message.type === "user";
}

function replayedSendId(message: SDKMessage): string | undefined {
  return message.type === "user" && "isReplay" in message && message.isReplay
    ? message.uuid
    : undefined;
}

export class SdkTurnRouter {
  /** Rome sends not yet answered. */
  private readonly sends = new Set<string>();
  /** Uuids minted for sends without an inputId; they report no input status. */
  private readonly minted = new Set<string>();
  /** Steers sent into the running SDK turn and not yet replayed. */
  private readonly pendingSteers = new Set<string>();
  /** Carried steers reported queued; the next Rome turn for them adopts them. */
  private readonly carried = new Set<string>();
  /** Sends the SDK turn now streaming has answered. */
  private readonly answered = new Set<string>();
  /** Owner of the SDK turn now streaming; undefined between turns. */
  private owner: "rome" | "sdk" | undefined;
  /** The send that opened the current Rome turn. */
  private turnSendId: string | undefined;
  private turnOpened: (() => void) | undefined;

  /**
   * Rome opens a turn for `inputId`. Returns the uuid to send, or `adopted`
   * when the SDK already holds that send as a carried steer.
   */
  openTurn(inputId?: string): { adopted: true } | { adopted: false; uuid: string } {
    this.releaseWait();
    if (inputId && this.carried.delete(inputId)) {
      this.turnSendId = inputId;
      return { adopted: true };
    }
    const uuid = inputId ?? randomUUID();
    this.turnSendId = uuid;
    this.sends.add(uuid);
    if (!inputId) this.minted.add(uuid);
    return { adopted: false, uuid };
  }

  /** Rome sends `inputId` into the running SDK turn. */
  steer(inputId: string): void {
    this.pendingSteers.add(inputId);
    this.sends.add(inputId);
  }

  /** Resolves when Rome opens a turn, or `releaseWait` runs. */
  waitForTurn(): Promise<void> {
    return new Promise((resolve) => {
      this.turnOpened = resolve;
    });
  }

  /** Ends any wait; for interrupt and close. */
  releaseWait(): void {
    this.turnOpened?.();
    this.turnOpened = undefined;
  }

  /** Decide one message. `turnOpen`: a Rome turn is open now. */
  onMessage(message: SDKMessage, turnOpen: boolean): FrameDecision {
    const replayed = replayedSendId(message);
    const romeReplay = replayed !== undefined && this.sends.has(replayed);
    const modelFrame = isModelFrame(message);
    const echoed = modelFrame ? echoedSendIds(message).filter((id) => this.sends.has(id)) : [];
    const before = this.owner;
    // A frame echoing a Rome send gives the turn to Rome; later frames carry
    // no echo and keep the owner. A turn that starts without one is the SDK's.
    if (modelFrame) this.owner = echoed.length > 0 ? "rome" : (this.owner ?? "sdk");
    for (const id of echoed) this.answered.add(id);

    // Output that newly claims a Rome send.
    const claimed = romeReplay ? replayed : before !== "rome" ? echoed[0] : undefined;
    let waitForTurn: string | undefined;
    if (claimed !== undefined && !turnOpen) {
      if (this.carried.size > 0) {
        waitForTurn = claimed;
      } else {
        // No Rome turn is open or coming: the reply has nowhere to go.
        for (const id of romeReplay ? [replayed] : echoed) this.forget(id);
        this.pendingSteers.delete(claimed);
        if (!romeReplay) this.owner = "sdk";
        return { action: "skip", dropped: claimed };
      }
    }
    if (romeReplay) {
      this.pendingSteers.delete(replayed);
      const consumed = this.minted.has(replayed) ? undefined : replayed;
      return { action: "deliver", waitForTurn, consumed };
    }
    if (this.owner === "sdk" && isTurnFrame(message)) return { action: "skip" };
    return { action: "deliver", waitForTurn };
  }

  /** Decide a result, and forget the sends its SDK turn answered. */
  onResult(result: SDKResultMessage): ResultDecision {
    const echoed = echoedSendIds(result).filter((id) => this.sends.has(id));
    const ownerAtResult = this.owner;
    this.owner = undefined;
    for (const id of echoed) this.answered.add(id);
    const sdkOwned =
      echoed.length === 0 &&
      ownerAtResult !== "rome" &&
      (ownerAtResult === "sdk" || result.origin?.kind === "task-notification");
    const answered = [...this.answered];
    this.answered.clear();
    // The SDK's own turn answered no Rome send: any echo would have made it Rome's.
    if (sdkOwned) return { owner: "sdk", carried: [] };
    const carried = [...this.pendingSteers];
    this.pendingSteers.clear();
    for (const id of carried) this.carried.add(id);
    // A result that answers nothing (a frameless SDK error) takes the place of
    // this turn's own reply. A steer carried past it is still unanswered.
    if (answered.length === 0 && this.turnSendId) answered.push(this.turnSendId);
    for (const id of answered) if (!carried.includes(id)) this.forget(id);
    return { owner: "rome", carried };
  }

  /** Rome sends still awaiting an answer; for tests and diagnostics. */
  get trackedSendCount(): number {
    return this.sends.size;
  }

  private forget(id: string): void {
    this.sends.delete(id);
    this.minted.delete(id);
  }
}
