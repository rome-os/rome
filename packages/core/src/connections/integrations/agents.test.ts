import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import {
  type AgentMessageEnvelope,
  type AgentMessagingClient,
  AgentMessagingError,
} from "../../lib/rome-cloud-agents.js";
import { createTestDb } from "../../test/helpers.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { ConnectionRegistry } from "../registry.js";
import type { StreamFault } from "../types.js";
import {
  createAgentsTalker,
  makeAgentsDescriptor,
  makeAgentsSetup,
  reviveAgentsProfile,
  toAgentInboundMessage,
} from "./agents.js";

const ATLAS = "6f1c2d9e-0a4b-4c1d-9e2f-3a4b5c6d7e8f";
const HOME = { agentId: "0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70", name: "home-rome" };

function envelope(overrides: Partial<AgentMessageEnvelope> = {}): AgentMessageEnvelope {
  return {
    messageId: "msg_1",
    from: { agentId: ATLAS, name: "atlas", kind: "dot", account: "ouou", sameAccount: true },
    to: HOME,
    sentAt: "2026-10-07T07:35:36.000Z",
    text: "Refund requested on order #41",
    data: null,
    inReplyTo: null,
    hop: 0,
    ...overrides,
  };
}

function fakeClient(pages: AgentMessageEnvelope[][]): AgentMessagingClient & {
  acknowledged: string[][];
  sent: unknown[];
} {
  const acknowledged: string[][] = [];
  const sent: unknown[] = [];
  return {
    acknowledged,
    sent,
    agents: async () => ({ self: HOME, agents: [] }),
    poll: async () => ({ self: HOME, messages: pages.shift() ?? [] }),
    acknowledge: async (ids) => {
      acknowledged.push(ids);
    },
    send: async (input) => {
      sent.push(input);
      return { messageId: "msg_sent", to: { agentId: input.to, name: "atlas" } };
    },
  };
}

afterEach(() => {
  rs.useRealTimers();
});

/** Lets the poll loop run until `ready` holds, advancing fake time when it is on. */
async function until(ready: () => boolean, fakeTime = false): Promise<void> {
  for (let tick = 0; tick < 200; tick++) {
    if (ready()) return;
    if (fakeTime) await rs.advanceTimersByTimeAsync(1);
    else await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never held");
}

describe("agents channel", () => {
  it("turns an agent message into a direct message from its agent id", () => {
    const inbound = toAgentInboundMessage(envelope({ data: { order: 41 }, inReplyTo: "msg_0" }))!;
    expect(inbound).toMatchObject({
      messageId: "msg_1",
      conversationId: ATLAS,
      senderId: ATLAS,
      senderDisplayName: "atlas (dot)",
      thread: { kind: "dm" },
      replyTo: { messageId: "msg_0" },
    });
    expect(inbound.text).toContain("Refund requested on order #41");
    expect(inbound.text).toContain('"order": 41');
  });

  it("names another account's agent with its account, and keys it by agent id alone", () => {
    const external = envelope({
      from: {
        agentId: ATLAS,
        name: "atlas",
        kind: "dot",
        account: "friend",
        sameAccount: false,
      },
    });
    expect(toAgentInboundMessage(external)).toMatchObject({
      conversationId: ATLAS,
      senderId: ATLAS,
      senderDisplayName: "atlas (@friend's dot)",
    });
    const renamed = envelope({ from: { ...external.from, name: "nova", account: "newfriend" } });
    expect(toAgentInboundMessage(renamed)?.senderId).toBe(ATLAS);
  });

  it("drops a message from an agent Cloud has removed, and still acknowledges it", async () => {
    const removed = envelope({
      messageId: "msg_removed",
      from: { ...envelope().from, agentId: null },
    });
    expect(toAgentInboundMessage(removed)).toBeNull();
    const client = fakeClient([[removed, envelope({ messageId: "msg_2" })]]);
    const talker = createAgentsTalker(client);
    const delivered: ChannelMessage[] = [];
    talker.start(
      (message) => delivered.push(message),
      () => {},
    );
    await until(() => client.acknowledged.length > 0);
    expect(client.acknowledged).toEqual([["msg_removed", "msg_2"]]);
    expect(delivered.map((message) => message.messageId)).toEqual(["msg_2"]);
    await talker.stop();
  });

  it("keeps messages whose sender has no agentId, and reports the connection broken", async () => {
    const { agentId: _, ...from } = envelope().from;
    const client = fakeClient([
      [envelope({ from: from as never }), envelope({ messageId: "msg_2" })],
    ]);
    const talker = createAgentsTalker(client);
    const delivered: ChannelMessage[] = [];
    const faults: unknown[] = [];
    talker.start(
      (message) => delivered.push(message),
      (fault) => faults.push(fault),
    );
    await until(() => faults.length > 0);
    expect(faults[0]).toBeInstanceOf(Disconnected);
    expect(delivered).toEqual([]);
    expect(client.acknowledged).toEqual([]);
    await talker.stop();
  });

  it("keeps a message whose sender id is not in Cloud's spelling, and reports the connection broken", async () => {
    const odd = envelope({ from: { ...envelope().from, agentId: ATLAS.toUpperCase() } });
    const client = fakeClient([[odd]]);
    const talker = createAgentsTalker(client);
    const faults: unknown[] = [];
    talker.start(
      () => {},
      (fault) => faults.push(fault),
    );
    await until(() => faults.length > 0);
    expect(faults[0]).toBeInstanceOf(Disconnected);
    expect(client.acknowledged).toEqual([]);
    await talker.stop();
  });

  it("delivers polled messages, then acknowledges them", async () => {
    const client = fakeClient([[envelope(), envelope({ messageId: "msg_2" })]]);
    const talker = createAgentsTalker(client);
    const delivered: ChannelMessage[] = [];
    talker.start(
      (message) => delivered.push(message),
      () => {},
    );
    await until(() => client.acknowledged.length > 0);
    expect(client.acknowledged).toEqual([["msg_1", "msg_2"]]);
    expect(delivered.map((message) => message.messageId)).toEqual(["msg_1", "msg_2"]);
    await talker.stop();
  });

  it("keeps polling with backoff after a failure", async () => {
    rs.useFakeTimers();
    const client = fakeClient([]);
    let calls = 0;
    client.poll = async () => {
      calls++;
      if (calls === 1) throw new Error("Rome Cloud unavailable");
      return { self: HOME, messages: [envelope()] };
    };
    const talker = createAgentsTalker(client);
    const delivered: ChannelMessage[] = [];
    talker.start(
      (message) => delivered.push(message),
      () => {},
    );
    await until(() => calls === 1, true);
    expect(delivered).toHaveLength(0);
    await rs.advanceTimersByTimeAsync(20_000);
    await until(() => delivered.length === 1, true);
    await talker.stop();
  });

  it.each([
    ["an unknown or revoked token", new AgentMessagingError("unauthorized", 401)],
    ["a forbidden token", new AgentMessagingError("forbidden", 403)],
    ["a Rome no longer linked", new AgentMessagingError("not linked", undefined, "no_token")],
  ])("reports %s as a rejected credential and stops polling", async (_case, error) => {
    const client = fakeClient([]);
    let calls = 0;
    client.poll = async () => {
      calls++;
      throw error;
    };
    const talker = createAgentsTalker(client);
    const faults: StreamFault[] = [];
    talker.start(
      () => {},
      (fault) => faults.push(fault),
    );
    await until(() => faults.length > 0);
    expect(faults[0]).toBeInstanceOf(CredentialRejected);
    expect((faults[0] as CredentialRejected).grant).toBe("cloud");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    await talker.stop();
  });

  it("degrades the grant when Cloud rejects the token, rather than renewing it unchanged", async () => {
    const client = fakeClient([]);
    const rejected = new AgentMessagingError("not linked", undefined, "no_token");
    client.poll = async () => {
      throw rejected;
    };
    client.agents = async () => {
      throw rejected;
    };
    const registry = new ConnectionRegistry({
      ledger: new DrizzleGrantLedger(createTestDb().db),
    });
    registry.register(makeAgentsDescriptor(client));
    const conn = await registry.connect("agents");
    await registry.importCredential(conn.id, "cloud", { material: HOME, expiresAt: "never" }, HOME);
    await until(() => conn.auth.grants().cloud === "degraded");
    expect(conn.isUnlocked("talk")).toBe(false);
  });

  it("refuses attachments rather than sending only the text", async () => {
    const client = fakeClient([]);
    const talker = createAgentsTalker(client);
    await expect(
      talker.send(ATLAS as ConversationId, {
        text: "Here is the invoice",
        attachments: [{ type: "document", source: "/tmp/invoice.pdf" }],
      }),
    ).rejects.toThrow(/text only/);
    expect(client.sent).toEqual([]);
  });

  it("sends to the agent id named by the conversation and threads replies", async () => {
    const client = fakeClient([]);
    const talker = createAgentsTalker(client);
    const receipt = await talker.send(ATLAS as ConversationId, {
      text: "On it",
      replyToMessageId: "msg_1",
    });
    expect(client.sent).toEqual([{ to: ATLAS, text: "On it", inReplyTo: "msg_1" }]);
    expect(receipt).toEqual({ conversationId: ATLAS, messageId: "msg_sent" });
    await expect(talker.send(ATLAS as ConversationId, { text: " " })).rejects.toThrow(/text/);
  });

  it("says plainly when Cloud will not deliver to an agent", async () => {
    const client = fakeClient([]);
    client.send = async () => {
      throw new AgentMessagingError("Not reachable", 404, "not_reachable");
    };
    await expect(
      createAgentsTalker(client).send(ATLAS as ConversationId, { text: "Hi" }),
    ).rejects.toThrow(
      "Rome Cloud can't deliver to this agent. It may no longer exist, or no link between your accounts lets this Rome reach it.",
    );
  });

  it("refuses a name in place of an agent id without asking Cloud", async () => {
    const client = fakeClient([]);
    await expect(
      createAgentsTalker(client).send("atlas" as ConversationId, { text: "Hi" }),
    ).rejects.toThrow("Address an agent by its agent id (a UUID), not its name.");
    expect(client.sent).toEqual([]);
  });

  it("reaches a dot directly at its agent id, so People can write to it first", async () => {
    const direct = createAgentsTalker(fakeClient([])).directMessaging;
    expect(await direct?.conversationFor(ATLAS)).toBe(ATLAS);
    expect(await direct?.conversationFor(" ")).toBeNull();
    // A link left from before agent ids offers nothing to write to.
    expect(await direct?.conversationFor("atlas")).toBeNull();
  });

  it("records the agent Cloud assigned when the guardian connects", async () => {
    const setup = makeAgentsSetup(fakeClient([]));
    const conferral = await setup(
      { show: () => {} } as never,
      {
        step: (_label: string, fn: (signal: AbortSignal) => Promise<unknown>) =>
          fn(new AbortController().signal),
      } as never,
    );
    expect(conferral.profile).toEqual(HOME);
    expect(reviveAgentsProfile(HOME).handle).toBe("home-rome");
  });

  it("shows the name a grant from before agent ids recorded, rather than failing", () => {
    expect(reviveAgentsProfile({ endpoint: "home-rome" }).handle).toBe("home-rome");
    expect(reviveAgentsProfile({ endpointId: "ep-1", name: "home-rome" }).handle).toBe("home-rome");
    expect(reviveAgentsProfile({}).handle).toBeUndefined();
  });
});
