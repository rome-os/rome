import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import {
  type AgentMessageEnvelope,
  type AgentMessagingClient,
  AgentMessagingError,
} from "../../lib/rome-cloud-agents.js";
import { createTestDb } from "../../test/helpers.js";
import { CredentialRejected } from "../errors.js";
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

function envelope(overrides: Partial<AgentMessageEnvelope> = {}): AgentMessageEnvelope {
  return {
    messageId: "msg_1",
    from: { endpoint: "atlas", kind: "dot" },
    to: { endpoint: "home-rome" },
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
    endpoints: async () => ({ endpoint: "home-rome", endpoints: [] }),
    poll: async () => ({ endpoint: "home-rome", messages: pages.shift() ?? [] }),
    acknowledge: async (ids) => {
      acknowledged.push(ids);
    },
    send: async (input) => {
      sent.push(input);
      return { messageId: "msg_sent", to: input.to };
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
  it("turns an agent message into a direct message from its endpoint", () => {
    const inbound = toAgentInboundMessage(envelope({ data: { order: 41 }, inReplyTo: "msg_0" }))!;
    expect(inbound).toMatchObject({
      messageId: "msg_1",
      conversationId: "atlas",
      senderId: "atlas",
      senderDisplayName: "atlas (dot)",
      thread: { kind: "dm" },
      replyTo: { messageId: "msg_0" },
    });
    expect(inbound.text).toContain("Refund requested on order #41");
    expect(inbound.text).toContain('"order": 41');
  });

  it("addresses another account's agent by its account, so two accounts' names never meet", () => {
    const external = envelope({
      from: {
        endpoint: "atlas",
        endpointId: "6f1c",
        kind: "dot",
        sameAccount: false,
        account: "friend",
        address: "@friend/atlas",
      },
    });
    expect(toAgentInboundMessage(external)).toMatchObject({
      conversationId: "@friend/atlas",
      senderId: "@friend/atlas",
      senderDisplayName: "@friend/atlas (external dot)",
    });
    const own = envelope({
      from: { endpoint: "atlas", kind: "dot", sameAccount: true, account: "ouou" },
    });
    expect(toAgentInboundMessage(own)).toMatchObject({
      conversationId: "atlas",
      senderId: "atlas",
    });
  });

  it("drops a cross-account message that names no sender account, and still acknowledges it", async () => {
    const nameless = envelope({
      messageId: "msg_nameless",
      from: { endpoint: "atlas", kind: "dot", sameAccount: false },
    });
    expect(toAgentInboundMessage(nameless)).toBeNull();
    const client = fakeClient([[nameless, envelope({ messageId: "msg_2" })]]);
    const talker = createAgentsTalker(client);
    const delivered: ChannelMessage[] = [];
    talker.start(
      (message) => delivered.push(message),
      () => {},
    );
    await until(() => client.acknowledged.length > 0);
    expect(client.acknowledged).toEqual([["msg_nameless", "msg_2"]]);
    expect(delivered.map((message) => message.messageId)).toEqual(["msg_2"]);
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
      return { endpoint: "home-rome", messages: [envelope()] };
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
    client.endpoints = async () => {
      throw rejected;
    };
    const registry = new ConnectionRegistry({
      ledger: new DrizzleGrantLedger(createTestDb().db),
    });
    registry.register(makeAgentsDescriptor(client));
    const conn = await registry.connect("agents");
    await registry.importCredential(
      conn.id,
      "cloud",
      { material: { endpoint: "home-rome" }, expiresAt: "never" },
      { endpoint: "home-rome" },
    );
    await until(() => conn.auth.grants().cloud === "degraded");
    expect(conn.talk).toBeNull();
  });

  it("refuses attachments rather than sending only the text", async () => {
    const client = fakeClient([]);
    const talker = createAgentsTalker(client);
    await expect(
      talker.send("atlas" as ConversationId, {
        text: "Here is the invoice",
        attachments: [{ type: "document", source: "/tmp/invoice.pdf" }],
      }),
    ).rejects.toThrow(/text only/);
    expect(client.sent).toEqual([]);
  });

  it("sends to the endpoint named by the conversation and threads replies", async () => {
    const client = fakeClient([]);
    const talker = createAgentsTalker(client);
    const receipt = await talker.send("atlas" as ConversationId, {
      text: "On it",
      replyToMessageId: "msg_1",
    });
    expect(client.sent).toEqual([{ to: "atlas", text: "On it", inReplyTo: "msg_1" }]);
    expect(receipt).toEqual({ conversationId: "atlas", messageId: "msg_sent" });
    await expect(talker.send("atlas" as ConversationId, { text: " " })).rejects.toThrow(/text/);
  });

  it("sends to another account's agent by its full address", async () => {
    const client = fakeClient([]);
    const talker = createAgentsTalker(client);
    await talker.send("@friend/atlas" as ConversationId, { text: "Hi" });
    expect(client.sent).toEqual([{ to: "@friend/atlas", text: "Hi" }]);
  });

  it("says plainly when Cloud will not deliver to an address", async () => {
    const client = fakeClient([]);
    client.send = async () => {
      throw new AgentMessagingError("Not reachable", 404, "not_reachable");
    };
    const talker = createAgentsTalker(client);
    await expect(talker.send("@friend/atlas" as ConversationId, { text: "Hi" })).rejects.toThrow(
      "Rome Cloud can't deliver to @friend/atlas. The agent may not exist, or its owner hasn't linked their account with yours.",
    );
  });

  it("reaches a dot directly at its endpoint, so People can write to it first", async () => {
    const direct = createAgentsTalker(fakeClient([])).directMessaging;
    expect(await direct?.conversationFor("atlas")).toBe("atlas");
    expect(await direct?.conversationFor(" ")).toBeNull();
  });

  it("records the endpoint Cloud assigned when the guardian connects", async () => {
    const setup = makeAgentsSetup(fakeClient([]));
    const conferral = await setup(
      { show: () => {} } as never,
      {
        step: (_label: string, fn: (signal: AbortSignal) => Promise<unknown>) =>
          fn(new AbortController().signal),
      } as never,
    );
    expect(conferral.profile).toEqual({ endpoint: "home-rome" });
    expect(reviveAgentsProfile({ endpoint: "home-rome" }).handle).toBe("home-rome");
  });
});
