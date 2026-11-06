import { describe, expect, it } from "@rstest/core";
import { comparable, exemplar, loadCapture } from "./capture.js";
import postCapture from "./captures/feishu-post.capture.json" with { type: "json" };
import { FeishuPeer } from "./feishu.js";
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

function post(text: string): string {
  return JSON.stringify({ zh_cn: { title: "", content: [[{ tag: "md", text }]] } });
}
