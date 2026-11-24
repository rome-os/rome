import { describe, expect, it } from "@rstest/core";
import {
  type ConnectionSayDeps,
  type EnvoyVerdict,
  envoyPrompt,
  readEnvoyVerdict,
  type SendGateDecision,
  sayOnConnection,
  sendOnConnection,
} from "./connection-say.js";

const chat = { id: "chat-1", channel: "discord_app", threadId: "900" };

function deps(
  over: Partial<ConnectionSayDeps> = {},
  verdict: EnvoyVerdict = { action: "approve" },
) {
  const sent: unknown[] = [];
  const records: unknown[] = [];
  const envoys: unknown[] = [];
  const all: ConnectionSayDeps = {
    // As guardedSend decides: an answer to the guardian goes out, Envoy checks any other.
    gate: ({ recipient }) => (recipient?.bondLevel === "guardian" ? "send" : "check"),
    connectionOf: (channel) => (channel === "discord_app" ? "conn-1" : null),
    envoy: async (input) => {
      envoys.push(input);
      return verdict;
    },
    send: async (target, text, replyTo, turnId) => {
      sent.push([target.id, text, replyTo, turnId]);
      return "800000000000000009";
    },
    record: async ({ status, description }) => {
      records.push([status, description]);
    },
    ...over,
  };
  return { all, sent, records, envoys };
}

const say = (d: ConnectionSayDeps, bondLevel: "guardian" | "acquaintance") =>
  sayOnConnection(d, {
    chat,
    text: "Hi!",
    replyTo: "800000000000000001",
    turnId: "turn-1",
    place: "group",
    recipient: { bondLevel, shownName: "Ada", said: "hello" },
  });

describe("what the Concierge says in a chat on a connection", () => {
  it("sends what answers the guardian at once, quoting the message, and puts it on record", async () => {
    const d = deps();
    expect(await say(d.all, "guardian")).toEqual({ sent: "800000000000000009" });
    expect(d.sent).toEqual([["chat-1", "Hi!", "800000000000000001", "turn-1"]]);
    expect(d.records).toEqual([["auto_approved", "Sent past the send gate"]]);
    expect(d.envoys).toEqual([]);
  });

  it("has Envoy check what answers anyone else, as the inbox does", async () => {
    const approved = deps();
    expect(await say(approved.all, "acquaintance")).toEqual({ sent: "800000000000000009" });
    expect(approved.envoys).toHaveLength(1);

    const held = deps({}, { action: "require_approval", reason: "Names a private file" });
    expect(await say(held.all, "acquaintance")).toEqual({
      notSent: "This message waits for the guardian's approval, so it was not sent yet.",
    });
    expect(held.sent).toEqual([]);
    expect(held.records).toEqual([["pending", "Names a private file"]]);

    const rejected = deps({}, { action: "reject", reason: "it repeats a DM" });
    expect(await say(rejected.all, "acquaintance")).toEqual({
      notSent: "This message was not sent: it repeats a DM.",
    });
    expect(rejected.sent).toEqual([]);
    expect(rejected.records).toEqual([["rejected", "it repeats a DM"]]);
  });

  it("follows a gate that refuses or asks the guardian", async () => {
    const refused = deps({ gate: () => "refuse" });
    expect(await say(refused.all, "guardian")).toMatchObject({ notSent: expect.any(String) });
    const asked = deps({ gate: () => "ask_guardian" });
    expect(await say(asked.all, "guardian")).toMatchObject({ notSent: expect.any(String) });
    expect([...refused.sent, ...asked.sent]).toEqual([]);
  });

  it("refuses a chat whose account cannot send", async () => {
    await expect(say(deps({ connectionOf: () => null }).all, "guardian")).rejects.toThrow(
      "cannot send",
    );
  });

  it("words Envoy's prompt as the inbox does, and holds an answer with no verdict", () => {
    const prompt = envoyPrompt({
      text: "Hi!",
      place: "group",
      recipient: { bondLevel: "acquaintance", shownName: "Ada", said: "hello" },
    });
    expect(prompt).toContain("Message being answered, from Ada [acquaintance]:\nhello");
    expect(prompt).toContain("in the same group chat");
    expect(prompt).toContain("Proposed reply:\nHi!");
    expect(readEnvoyVerdict({ verdict: "approve", reason: "fine" })).toEqual({
      action: "approve",
      reason: "fine",
    });
    expect(readEnvoyVerdict({ verdict: "maybe" }).action).toBe("require_approval");
    expect(readEnvoyVerdict(undefined).action).toBe("require_approval");
  });
});

describe("what the Concierge sends to another chat of its account", () => {
  const send = async (decision: SendGateDecision, thread?: string) => {
    const delivered: unknown[] = [];
    const records: unknown[] = [];
    const destinations: unknown[] = [];
    const said = await sendOnConnection(
      {
        gate: ({ destination }) => {
          destinations.push(destination);
          return decision;
        },
        connectionOf: (channel) => (channel === "slack_app" ? "slack" : null),
        deliver: async (channel, address, text, turnId) => {
          delivered.push([channel, address, text, turnId]);
          return "1.5";
        },
        record: async ({ status, chat: target }) => {
          records.push([status, target.threadId]);
        },
      },
      {
        from: { channel: "slack_app", threadId: "C1" },
        chat: "C2",
        ...(thread ? { thread } : {}),
        text: "Hi",
        turnId: "turn-1",
      },
    );
    return { said, delivered, records, destinations };
  };

  it("sends to the thread named, else the open chat, when the gate lets it", async () => {
    const inThread = await send("send", "C2:1.0");
    expect(inThread.said).toEqual({ sent: "1.5" });
    expect(inThread.delivered).toEqual([["slack_app", "C2:1.0", "Hi", "turn-1"]]);
    expect(inThread.records).toEqual([["auto_approved", "C2:1.0"]]);
    expect(inThread.destinations).toEqual([
      expect.objectContaining({ connectionId: "slack", chatId: "C2", sameChatAsWake: false }),
    ]);
    expect((await send("send")).delivered).toEqual([["slack_app", "C2", "Hi", "turn-1"]]);
  });

  it("holds for the guardian what the gate would check, and sends nothing the gate refuses", async () => {
    for (const decision of ["check", "ask_guardian"] as const) {
      const held = await send(decision);
      expect(held.delivered).toEqual([]);
      expect(held.records).toEqual([["pending", "C2"]]);
      expect(held.said).toHaveProperty("notSent");
    }
    const refused = await send("refuse");
    expect(refused.delivered).toEqual([]);
    expect(refused.records).toEqual([["rejected", "C2"]]);
  });
});
