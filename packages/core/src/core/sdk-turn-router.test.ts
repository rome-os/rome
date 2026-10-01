import { describe, expect, it } from "@rstest/core";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { SdkTurnRouter } from "./sdk-turn-router.js";

// A top-level model frame; `echo` is the send uuid the SDK stamps on a turn's
// first frame.
function frame(echo?: string, parent: string | null = null): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: parent,
    ...(echo ? { user_message_uuid: echo } : {}),
    message: { content: [] },
  } as unknown as SDKMessage;
}

function replay(uuid: string): SDKMessage {
  return { type: "user", isReplay: true, uuid, parent_tool_use_id: null } as unknown as SDKMessage;
}

function result(opts: { echo?: string[]; origin?: "task-notification" } = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    ...(opts.echo ? { user_message_uuids: opts.echo } : {}),
    ...(opts.origin ? { origin: { kind: opts.origin } } : {}),
  } as unknown as SDKResultMessage;
}

const deliver = { action: "deliver" };
const skip = { action: "skip" };

describe("SdkTurnRouter", () => {
  it("gives a turn that echoes Rome's send to Rome, and forgets the send at its result", () => {
    const r = new SdkTurnRouter();
    expect(r.openTurn("A")).toEqual({ adopted: false, uuid: "A" });
    expect(r.onMessage(frame("A"), true)).toEqual(deliver);
    expect(r.onMessage(frame(), true)).toEqual(deliver);
    expect(r.onResult(result({ echo: ["A"] }))).toEqual({ owner: "rome", carried: [] });
    expect(r.trackedSendCount).toBe(0);
  });

  it("skips a turn the SDK starts while Rome is idle", () => {
    const r = new SdkTurnRouter();
    expect(r.onMessage(frame(), false)).toEqual(skip);
    expect(r.onMessage(replay("tool-result"), false)).toEqual(skip);
    expect(r.onResult(result())).toEqual({ owner: "sdk", carried: [] });
  });

  it("gives a frameless result to the SDK only when its origin is task-notification", () => {
    const r = new SdkTurnRouter();
    r.openTurn("A");
    expect(r.onResult(result({ origin: "task-notification" })).owner).toBe("sdk");
    expect(r.trackedSendCount).toBe(1);
    // A frameless, origin-less error takes the place of A's reply.
    expect(r.onResult(result()).owner).toBe("rome");
    expect(r.trackedSendCount).toBe(0);
    // A's reply, if it still comes, is the SDK's.
    expect(r.onMessage(frame("A"), false)).toEqual(skip);
    expect(r.onResult(result()).owner).toBe("sdk");
  });

  it("hands an SDK turn to Rome from the frame that echoes a folded send", () => {
    const r = new SdkTurnRouter();
    expect(r.onMessage(frame(), false)).toEqual(skip);
    r.openTurn("X");
    expect(r.onMessage(frame(), true)).toEqual(skip);
    expect(r.onMessage(frame("X"), true)).toEqual(deliver);
    expect(r.onMessage(frame(), true)).toEqual(deliver);
    expect(r.onResult(result({ origin: "task-notification" })).owner).toBe("rome");
    expect(r.trackedSendCount).toBe(0);
  });

  it("takes ownership only from top-level frames", () => {
    const r = new SdkTurnRouter();
    r.openTurn("A");
    expect(r.onMessage(frame("A", "tool-1"), true)).toEqual(deliver);
    expect(r.onMessage(frame(), true)).toEqual(skip);
  });

  it("reports a replayed steer consumed and forgets it at the result", () => {
    const r = new SdkTurnRouter();
    r.openTurn("A");
    r.steer("S");
    r.onMessage(frame("A"), true);
    expect(r.onMessage(replay("S"), true)).toEqual({ ...deliver, consumed: "S" });
    expect(r.onMessage(frame("S"), true)).toEqual(deliver);
    // The result echoes only A; S was answered in this turn all the same.
    expect(r.onResult(result({ echo: ["A"] }))).toEqual({ owner: "rome", carried: [] });
    expect(r.trackedSendCount).toBe(0);
  });

  it("reports no input status for a minted send's replay", () => {
    const r = new SdkTurnRouter();
    const turn = r.openTurn();
    if (turn.adopted) throw new Error("expected a new send");
    expect(r.onMessage(replay(turn.uuid), true)).toEqual(deliver);
  });

  it("waits for Rome's next turn to carry a steer the SDK runs after the result", async () => {
    const r = new SdkTurnRouter();
    r.openTurn("A");
    r.steer("S");
    r.onMessage(frame("A"), true);
    expect(r.onResult(result({ echo: ["A"] }))).toEqual({ owner: "rome", carried: ["S"] });
    expect(r.onMessage(replay("S"), false)).toEqual({
      ...deliver,
      waitForTurn: "S",
      consumed: "S",
    });
    const waited = r.waitForTurn();
    expect(r.openTurn("S")).toEqual({ adopted: true });
    await waited;
    expect(r.onMessage(frame("S"), true)).toEqual(deliver);
    expect(r.onResult(result({ echo: ["S"] })).owner).toBe("rome");
    expect(r.trackedSendCount).toBe(0);
  });

  it("keeps a send replayed during an SDK turn until a turn echoes it", () => {
    const r = new SdkTurnRouter();
    expect(r.onMessage(frame(), false)).toEqual(skip);
    r.openTurn("X");
    // The SDK replays X inside its own turn but answers it in the next one.
    expect(r.onMessage(replay("X"), true)).toEqual({ ...deliver, consumed: "X" });
    expect(r.onResult(result({ origin: "task-notification" })).owner).toBe("sdk");
    expect(r.onMessage(frame("X"), true)).toEqual(deliver);
    expect(r.onResult(result({ echo: ["X"] })).owner).toBe("rome");
    expect(r.trackedSendCount).toBe(0);
  });

  it("drops, and reports, a reply to a steer replayed before the result but answered after", () => {
    const r = new SdkTurnRouter();
    r.openTurn("A");
    r.steer("S");
    r.onMessage(frame("A"), true);
    expect(r.onMessage(replay("S"), true)).toEqual({ ...deliver, consumed: "S" });
    // S was consumed in A's turn, so it is not carried and no turn is coming.
    expect(r.onResult(result({ echo: ["A"] }))).toEqual({ owner: "rome", carried: [] });
    expect(r.onMessage(frame("S"), false)).toEqual({ ...skip, dropped: "S" });
    expect(r.onResult(result({ echo: ["S"] })).owner).toBe("sdk");
    expect(r.trackedSendCount).toBe(0);
  });

  it("drops a late reply instead of waiting when no Rome turn is coming", () => {
    const r = new SdkTurnRouter();
    r.openTurn("A");
    r.openTurn("B");
    r.onMessage(frame("B"), true);
    r.onResult(result({ echo: ["B"] }));
    // A is still unanswered, no turn is open and none is queued.
    expect(r.onMessage(frame("A"), false)).toEqual({ ...skip, dropped: "A" });
    expect(r.onMessage(frame(), false)).toEqual(skip);
    expect(r.onResult(result({ echo: ["A"] })).owner).toBe("sdk");
    expect(r.trackedSendCount).toBe(0);
  });

  it("lets another caller's turn release the wait for a carried steer", async () => {
    const r = new SdkTurnRouter();
    r.openTurn("A");
    r.steer("S");
    r.onMessage(frame("A"), true);
    r.onResult(result({ echo: ["A"] }));
    expect(r.onMessage(frame("S"), false)).toEqual({ ...deliver, waitForTurn: "S" });
    const waited = r.waitForTurn();
    // B's turn opens first. S's reply goes to it, as on main.
    expect(r.openTurn("B")).toEqual({ adopted: false, uuid: "B" });
    await waited;
    expect(r.onResult(result({ echo: ["S"] })).owner).toBe("rome");
    // B's reply waits for S's turn, which is still queued.
    expect(r.onMessage(frame("B"), false)).toEqual({ ...deliver, waitForTurn: "B" });
    expect(r.openTurn("S")).toEqual({ adopted: true });
    expect(r.onResult(result({ echo: ["B"] })).owner).toBe("rome");
    expect(r.trackedSendCount).toBe(0);
  });

  it("ends a wait on releaseWait", async () => {
    const r = new SdkTurnRouter();
    const waited = r.waitForTurn();
    r.releaseWait();
    await waited;
  });
});
