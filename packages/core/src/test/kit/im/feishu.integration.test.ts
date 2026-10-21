import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { setTimeout as sleep } from "node:timers/promises";
import { Pacer } from "../../../channels/delivery/pacer.js";
import { ReplyDelivery } from "../../../channels/delivery/reply.js";
import { FEISHU_MAX_EDITS, feishuTransport } from "../../../channels/delivery/transports/feishu.js";
import {
  DeliveryFailure,
  type DeliveryPolicy,
  type DeliveryTransport,
} from "../../../channels/delivery/types.js";
import { systemClock } from "../../../lib/clock.js";
import { comparable, exemplar, loadCapture } from "./capture.js";
import postCapture from "./captures/feishu-post.capture.json" with { type: "json" };
import { FEISHU_CHAT, FeishuPeer } from "./feishu.js";
import { checkDelivery } from "./invariants.js";
import type { PeerExchange } from "./peer.js";

const capture = loadCapture(postCapture);
const MESSAGES = "/open-apis/im/v1/messages";

function lastMessageExchange(peer: FeishuPeer): PeerExchange | undefined {
  return peer.server.exchanges.filter((e) => e.request.path.startsWith(MESSAGES)).at(-1);
}

describe("FeishuPeer", () => {
  it.each([
    "open.feishu.cn.evil.invalid",
    "open.feishu.cnevil.invalid",
  ])("blocks a similar host before sending a request (%s)", async (host) => {
    const peer = await FeishuPeer.start();
    const url = `https://${host}${MESSAGES}`;
    try {
      await expect(
        Promise.resolve().then(() => peer.createClient().httpInstance.get(url)),
      ).rejects.toThrow(`Peer blocked a request to ${url}`);
      expect(peer.server.exchanges).toEqual([]);
      peer.server.assertClean();
    } finally {
      await peer.close();
    }
  });

  it("answers the recorded requests the way Feishu did", async () => {
    const peer = await FeishuPeer.start();
    const message = peer.createClient().im.v1.message;
    const calls: Record<string, (body: never) => Promise<unknown>> = {
      create: (data) => message.create({ params: { receive_id_type: "chat_id" }, data }),
      "reply-in-thread": (data) => message.reply({ path: { message_id: "om_1" }, data }),
      update: (data) => message.update({ path: { message_id: "om_1" }, data }),
    };
    try {
      for (const { label, request, response } of capture.exchanges) {
        const call = calls[label];
        if (!call) continue;
        await call(request.body as never);
        const answered = lastMessageExchange(peer)?.response ?? { body: undefined };
        expect({ label, ...comparable(capture, answered, response) }).toEqual({
          label,
          ...comparable(capture, response, response),
        });
      }
      expect(
        peer.server.exchanges
          .filter((e) => e.request.path.startsWith(MESSAGES))
          .map((e) => e.source),
      ).toEqual(["capture", "capture", "capture"]);
      peer.server.assertClean();
    } finally {
      await peer.close();
    }
  });

  it("keeps a Markdown element as it was sent, as Feishu did", async () => {
    const peer = await FeishuPeer.start();
    const recorded = capture.exchanges.find((e) => e.label === "create-markdown")!;
    try {
      const answer = await peer.createClient().im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: recorded.request.body as never,
      });
      const expected = exemplar<{ data: { body: { content: string } } }>(
        capture,
        "create-markdown",
      );
      const contentOf = (raw?: string) => {
        const { title, content_v2 } = JSON.parse(raw ?? "{}") as Record<string, unknown>;
        return { title, content_v2 };
      };
      expect(contentOf(answer.data?.body?.content)).toEqual(contentOf(expected.data.body.content));
      expect(peer.visible().map((m) => m.text)).toEqual([
        "Rome fixture capture: **Markdown** 中文",
      ]);
    } finally {
      await peer.close();
    }
  });

  it("answers a write to a message that does not exist as Feishu answered a read of one", async () => {
    const peer = await FeishuPeer.start();
    try {
      await expect(
        peer.createClient().im.v1.message.update({
          path: { message_id: "om_404" },
          data: { msg_type: "post", content: post("hi") },
        }),
      ).rejects.toMatchObject({ response: { status: 400, data: { code: 99992354 } } });
      expect(lastMessageExchange(peer)?.source).toBe("capture");
    } finally {
      await peer.close();
    }
  });
});

describe("feishuTransport against the peer", () => {
  let peer: FeishuPeer;
  let inThread: boolean;
  let transport: DeliveryTransport;

  beforeEach(async () => {
    peer = await FeishuPeer.start();
    inThread = true;
    transport = feishuTransport({
      client: peer.createClient(),
      replyInThread: async () => inThread,
    });
  });

  afterEach(async () => {
    await peer.close();
    peer.server.assertClean();
  });

  it("answers the user in a thread, and sends the reply's later messages into it", async () => {
    const user = peer.userMessage("hello");

    const first = await transport.create(FEISHU_CHAT, "one", user.id);
    const second = await transport.create(first.chatId, "two");

    expect(first.chatId).toBe(`${FEISHU_CHAT}#thread:${user.id}`);
    expect(second.chatId).toBe(first.chatId);
    const thread = peer.threadOf(user.id);
    expect(thread).toBeDefined();
    expect([peer.threadOf(first.messageId), peer.threadOf(second.messageId)]).toEqual([
      thread,
      thread,
    ]);
    expect(peer.visible().map(({ from, text }) => ({ from, text }))).toEqual([
      { from: "user", text: "hello" },
      { from: "rome", text: "one" },
      { from: "rome", text: "two" },
    ]);
  });

  it("answers the user in the chat where the chat keeps replies there", async () => {
    inThread = false;
    const user = peer.userMessage("hello");

    const first = await transport.create(FEISHU_CHAT, "one", user.id);
    const second = await transport.create(first.chatId, "two");

    expect([first.chatId, second.chatId]).toEqual([FEISHU_CHAT, FEISHU_CHAT]);
    expect(peer.threadOf(first.messageId)).toBeUndefined();
    expect(peer.visible().map((m) => m.replyTo)).toEqual([undefined, user.id, undefined]);
  });

  it("sends the reply on its own when the user recalled their message", async () => {
    const user = peer.userMessage("hello");
    peer.recall(user.id);

    const receipt = await transport.create(FEISHU_CHAT, "one", user.id);

    expect(receipt.chatId).toBe(FEISHU_CHAT);
    expect(peer.visible().at(-1)).toMatchObject({ id: receipt.messageId, text: "one" });
    expect(peer.visible().at(-1)?.replyTo).toBeUndefined();
  });

  it("edits a message as a post, and refuses the edit after Feishu's last without asking", async () => {
    const receipt = await transport.create(FEISHU_CHAT, "0");
    for (let edit = 1; edit <= FEISHU_MAX_EDITS; edit += 1)
      await transport.edit!(receipt, String(edit));

    await expect(transport.edit!(receipt, "21")).rejects.toMatchObject({ kind: "unsupported" });
    const edits = peer.server.exchanges.filter((e) => e.request.method === "PUT");
    expect(edits).toHaveLength(FEISHU_MAX_EDITS);
    expect(edits.every((e) => e.request.body.msg_type === "post")).toBe(true);
    expect(peer.visible()).toEqual([
      expect.objectContaining({ text: String(FEISHU_MAX_EDITS), edits: FEISHU_MAX_EDITS }),
    ]);
  });

  it("does not count an edit Feishu refused against the message", async () => {
    const receipt = await transport.create(FEISHU_CHAT, "0");
    peer.server.once({
      method: "PUT",
      path: `${MESSAGES}/${receipt.messageId}`,
      respond: { status: 400, body: { code: 230020, msg: "request trigger frequency limit" } },
    });

    await expect(transport.edit!(receipt, "x")).rejects.toMatchObject({
      kind: "rate-limited",
      retryAfterMs: 1000,
    });
    for (let edit = 1; edit <= FEISHU_MAX_EDITS; edit += 1)
      await transport.edit!(receipt, String(edit));
    expect(peer.visible()[0]?.edits).toBe(FEISHU_MAX_EDITS);
  });

  it.each([
    {
      name: "a refusal Feishu answered with 200",
      answer: { status: 200, body: { code: 230072, msg: "edit limit reached" } },
      kind: "unsupported",
    },
    {
      name: "a refusal",
      answer: { status: 400, body: { code: 230071, msg: "not the sender" } },
      kind: "rejected",
    },
    {
      name: "a refused token",
      answer: { status: 400, body: { code: 99991663, msg: "invalid token" } },
      kind: "unauthorized",
    },
    {
      name: "a rate limit",
      answer: { status: 429, body: { code: 99991400, msg: "too many requests" } },
      kind: "rate-limited",
    },
    {
      name: "a server error",
      answer: { status: 503, body: "Service Unavailable" },
      kind: "unknown",
    },
  ])("names an edit answered with $name as $kind", async ({ answer, kind }) => {
    const receipt = await transport.create(FEISHU_CHAT, "0");
    peer.server.once({ method: "PUT", path: `${MESSAGES}/${receipt.messageId}`, respond: answer });

    await expect(transport.edit!(receipt, "1")).rejects.toMatchObject({ kind });
  });

  it("names a create whose answer never came back as unknown, though Feishu shows it", async () => {
    peer.server.once({ method: "POST", path: MESSAGES, dropAfterAccept: true });

    await expect(transport.create(FEISHU_CHAT, "one")).rejects.toMatchObject({ kind: "unknown" });
    expect(peer.visible().map((m) => m.text)).toEqual(["one"]);
  });

  it("names a write as unauthorized when Feishu will not mint the app a token", async () => {
    peer.refuseCredential();

    const failure = await transport.create(FEISHU_CHAT, "one").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DeliveryFailure);
    expect(failure).toMatchObject({ kind: "unauthorized" });
    expect(peer.visible()).toEqual([]);
  });

  it("names a write as unavailable when the token request gets a server error", async () => {
    peer.server.once({
      method: "POST",
      path: "/open-apis/auth/v3/tenant_access_token/internal",
      respond: { status: 503, body: "Service Unavailable" },
    });

    await expect(transport.create(FEISHU_CHAT, "one")).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(peer.visible()).toEqual([]);
  });

  it("names a write as unavailable when Feishu cannot be reached", async () => {
    const gone = await FeishuPeer.start();
    const client = gone.createClient();
    await gone.close();
    const unreachable = feishuTransport({ client, replyInThread: async () => true });

    await expect(unreachable.create(FEISHU_CHAT, "one")).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("a reply streamed to Feishu", () => {
  let peer: FeishuPeer;

  beforeEach(async () => {
    peer = await FeishuPeer.start();
  });

  afterEach(async () => {
    await peer.close();
    peer.server.assertClean();
  });

  function deliver(transport: DeliveryTransport, policy: DeliveryPolicy, replyTo?: string) {
    return new ReplyDelivery({
      transport,
      // Wide open: Feishu's budget is the transport's, and these tests do not test it.
      pacer: new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, systemClock),
      policy,
      conversation: FEISHU_CHAT,
      ...(replyTo ? { replyTo } : {}),
      clock: systemClock,
    });
  }

  const romeMessages = () => peer.visible().filter((message) => message.from === "rome");

  it("streams a long answer into the thread on the user's message", async () => {
    const transport = feishuTransport({
      client: peer.createClient(),
      replyInThread: async () => true,
    });
    const user = peer.userMessage("tell me a story");
    const delivery = deliver(
      transport,
      { mode: "edit", editIntervalMs: 20, blockWaitMs: 30, maxPendingChars: 100_000 },
      user.id,
    );
    const emit = (event: StreamAgentEvent) => delivery.accept(event);

    emit({ type: "text", content: COMMENTARY, blockId: "c", turnPhase: "commentary" });
    const [first, ...rest] = chunks(STORY, 400);
    emit({ type: "text_delta", content: first!, blockId: "a" });
    await peer.server.waitFor(() => romeMessages().length >= 2, 10_000);
    for (const chunk of rest) {
      emit({ type: "text_delta", content: chunk, blockId: "a" });
      await sleep(2);
    }
    emit({ type: "text", content: STORY, blockId: "a", turnPhase: "final" });
    emit({ type: "result", content: STORY });
    const outcome = await delivery.finish();

    expect(outcome.status).toBe("delivered");
    const messages = romeMessages();
    expect(messages.length).toBeGreaterThanOrEqual(4);
    expect(messages.some((message) => message.edits > 0)).toBe(true);
    const thread = peer.threadOf(user.id);
    expect(messages.map((message) => peer.threadOf(message.id))).toEqual(
      messages.map(() => thread),
    );
    const failed = checkDelivery({
      source: COMMENTARY + STORY,
      outcome,
      peer,
      conversation: FEISHU_CHAT,
      maxPartLength: transport.capabilities.maxPartLength,
    }).filter((check) => !check.ok);
    expect(failed).toEqual([]);
  });

  it("sends the rest as a new message once a message has had Feishu's last edit", async () => {
    const transport = feishuTransport({
      client: peer.createClient(),
      replyInThread: async () => true,
    });
    const delivery = deliver(transport, {
      mode: "edit",
      editIntervalMs: 0,
      blockWaitMs: 0,
      maxPendingChars: 100_000,
    });
    const words = Array.from({ length: FEISHU_MAX_EDITS + 5 }, (_, i) => `word${i + 1} `);
    const edits = () =>
      peer.server.exchanges.filter((e) => e.request.method === "PUT" && e.accepted).length;

    // One delta per write: each waits until Feishu applied the write before it.
    delivery.accept({ type: "text_delta", content: words[0]!, blockId: "a" });
    await peer.server.waitFor(() => romeMessages().length === 1);
    for (let i = 1; i <= FEISHU_MAX_EDITS; i += 1) {
      delivery.accept({ type: "text_delta", content: words[i]!, blockId: "a" });
      await peer.server.waitFor(() => edits() >= i);
    }
    for (const word of words.slice(FEISHU_MAX_EDITS + 1))
      delivery.accept({ type: "text_delta", content: word, blockId: "a" });
    const text = words.join("");
    delivery.accept({ type: "text", content: text, blockId: "a", turnPhase: "final" });
    const outcome = await delivery.finish();

    expect(outcome.status).toBe("delivered");
    expect(romeMessages().map(({ text, edits }) => ({ text, edits }))).toEqual([
      {
        text: words
          .slice(0, FEISHU_MAX_EDITS + 1)
          .join("")
          .trim(),
        edits: FEISHU_MAX_EDITS,
      },
      {
        text: words
          .slice(FEISHU_MAX_EDITS + 1)
          .join("")
          .trim(),
        edits: 0,
      },
    ]);
    const failed = checkDelivery({
      source: text,
      outcome,
      peer,
      conversation: FEISHU_CHAT,
      maxPartLength: transport.capabilities.maxPartLength,
    }).filter((check) => !check.ok);
    expect(failed).toEqual([]);
  });

  it("shows code that runs across messages as code in each of them", async () => {
    const transport = feishuTransport({
      client: peer.createClient(),
      replyInThread: async () => true,
    });
    const delivery = deliver(transport, {
      mode: "edit",
      editIntervalMs: 20,
      blockWaitMs: 30,
      maxPendingChars: 100_000,
    });
    const code = Array.from({ length: 250 }, (_, i) => `# step ${i + 1}\nprint(${i + 1})\n`);
    const text = `Here is the script:\n\n\`\`\`python\n${code.join("")}\`\`\`\n\nThat is all.`;
    for (const chunk of chunks(text, 400)) {
      delivery.accept({ type: "text_delta", content: chunk, blockId: "a" });
      await sleep(2);
    }
    delivery.accept({ type: "text", content: text, blockId: "a", turnPhase: "final" });
    const outcome = await delivery.finish();

    expect(outcome.status).toBe("delivered");
    const messages = romeMessages().map((message) => message.text);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(transport.capabilities.maxPartLength);
      // Every fence a message opens, it closes.
      expect(message.match(/^```/gm)!.length % 2).toBe(0);
    }
    expect(messages.slice(1).every((message) => message.startsWith("```python\n"))).toBe(true);
    // The comments stay comments, not headings brought down to H4.
    expect(messages.join("\n")).not.toContain("#### step");
    expect(messages.at(-1)).toMatch(/\n```\n\nThat is all\.$/);
  });
});

const COMMENTARY = "Let me think of a story first.";
// Long enough for several messages, with sentence breaks.
const STORY = Array.from(
  { length: 180 },
  (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog. `,
).join("");

function chunks(text: string, size: number): string[] {
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );
}

function post(text: string): string {
  return JSON.stringify({ zh_cn: { title: "", content: [[{ tag: "md", text }]] } });
}
