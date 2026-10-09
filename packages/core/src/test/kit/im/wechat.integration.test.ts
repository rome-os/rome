import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WechatAdapter } from "../../../channels/wechat.js";
import { comparable, loadCapture } from "./capture.js";
import textCapture from "./captures/wechat-text.capture.json" with { type: "json" };
import { deferred } from "./peer.js";
import { WECHAT_ORIGIN, WECHAT_TOKEN, WECHAT_USER, WechatPeer } from "./wechat.js";

const capture = loadCapture(textCapture);
const user = WECHAT_USER as ConversationId;
const SEND_PATH = "/ilink/bot/sendmessage";

describe("WechatPeer", () => {
  it("answers the recorded requests the way iLink did", async () => {
    const peer = await WechatPeer.start();
    try {
      for (const { label, request, response } of capture.exchanges) {
        const answer = await peer.fetch(`${WECHAT_ORIGIN}${request.path}`, {
          method: request.method,
          headers: { "content-type": "application/json", authorization: `Bearer ${WECHAT_TOKEN}` },
          body: JSON.stringify(request.body),
        });
        const answered = { status: answer.status, body: await answer.json() };
        expect({ label, ...comparable(capture, answered, response) }).toEqual({
          label,
          ...comparable(capture, response, response),
        });
      }
      peer.server.assertClean();
    } finally {
      await peer.close();
    }
  });
});

describe("WechatAdapter.send against the peer", () => {
  let peer: WechatPeer;
  let adapter: WechatAdapter;
  let statePath: string;

  beforeEach(async () => {
    peer = await WechatPeer.start();
    rs.stubGlobal("fetch", peer.fetch);
    statePath = await mkdtemp(join(tmpdir(), "rome-wechat-peer-"));
    adapter = peer.createAdapter(statePath);
    // The adapter answers only users it has heard from, with their context token.
    const heard = deferred<ChannelMessage>();
    adapter.onInbound(async (message) => heard.resolve(message));
    await adapter.start();
    peer.emitMessage("hello");
    await heard.promise;
  });

  afterEach(async () => {
    await adapter.stop();
    await peer.close();
    rs.unstubAllGlobals();
    await rm(statePath, { recursive: true, force: true });
  });

  it("sends with the user's context token and reports the message id iLink answers", async () => {
    const receipt = await adapter.send(user, { text: "hi there" });

    const sent = peer.visible().find((message) => message.from === "rome");
    expect(sent).toMatchObject({ text: "hi there" });
    expect(receipt).toEqual({ conversationId: user, messageId: sent?.id });
    const request = peer.server.exchanges.find((e) => e.request.path === SEND_PATH)?.request.body;
    expect(request).toMatchObject({
      msg: { to_user_id: WECHAT_USER, context_token: `context-${WECHAT_USER}` },
    });
    peer.server.assertClean();
  });
});
