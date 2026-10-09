import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import { REST, type RequestMethod, Routes } from "discord.js";
import type { DiscordAdapter } from "../../../channels/discord.js";
import { comparable, loadCapture } from "./capture.js";
import textCapture from "./captures/discord-text.capture.json" with { type: "json" };
import { DISCORD_DM, DISCORD_TOKEN, DiscordPeer } from "./discord.js";
import { deferred } from "./peer.js";

const capture = loadCapture(textCapture);
const dm = DISCORD_DM as ConversationId;

describe("DiscordPeer", () => {
  let peer: DiscordPeer;
  let rest: REST;

  beforeEach(async () => {
    peer = await DiscordPeer.start();
    rest = new REST({ version: "10", ...peer.restOptions() }).setToken(DISCORD_TOKEN);
  });

  afterEach(async () => {
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
    await peer.close();
  });

  it("answers the recorded requests the way Discord did", async () => {
    for (const { label, request, response } of capture.exchanges) {
      const call = rest.request({
        method: request.method as RequestMethod,
        fullRoute: request.path.replace("/api/v10", "") as `/${string}`,
        ...(request.method === "GET" ? {} : { body: request.body }),
      });
      // discord.js resolves only what Discord accepted.
      if (response.status === undefined) await call;
      else await expect(call).rejects.toMatchObject({ status: response.status });
      const answered = peer.server.exchanges.at(-1)?.response ?? { body: undefined };
      expect({ label, ...comparable(capture, answered, response) }).toEqual({
        label,
        ...comparable(capture, response, response),
      });
    }
    peer.server.assertClean();
  });

  it("refuses to open a DM with a user it does not know", async () => {
    await expect(
      rest.post(Routes.userChannels(), { body: { recipient_id: "100000000000000999" } }),
    ).rejects.toThrow();

    expect(() => peer.server.assertClean()).toThrow(
      "Unmodeled request: POST /api/v10/users/@me/channels",
    );
  });
});

describe("DiscordAdapter.send against the peer", () => {
  let peer: DiscordPeer;
  let adapter: DiscordAdapter;

  beforeEach(async () => {
    peer = await DiscordPeer.start();
    adapter = peer.createAdapter();
    await adapter.start();
    // The adapter registers its slash commands once the gateway says READY.
    await peer.server.waitFor((e) => e.request.path.endsWith("/commands") && !!e.response);
  });

  afterEach(async () => {
    await adapter.stop();
    await peer.close();
    // Every test, teardown included, made only requests the peer models.
    peer.server.assertClean();
  });

  async function receive(text: string): Promise<ChannelMessage> {
    const heard = deferred<ChannelMessage>();
    adapter.onInbound(async (message) => heard.resolve(message));
    peer.emitMessage(text);
    return heard.promise;
  }

  it("sends to a DM, reports the message id, and hears the answer there", async () => {
    // discord.js drops a DM whose channel it has not cached, and this peer's
    // MESSAGE_CREATE is synthetic, so the test opens the channel by sending first.
    const receipt = await adapter.send(dm, { text: "hi there" });
    const inbound = await receive("hello");

    expect(receipt).toEqual({ conversationId: dm, messageId: expect.any(String) });
    expect(inbound).toMatchObject({ conversationId: dm, text: "hello" });
    expect(peer.visible()).toEqual([
      expect.objectContaining({ id: receipt.messageId, from: "rome", text: "hi there" }),
      expect.objectContaining({ id: inbound.messageId, from: "user", text: "hello" }),
    ]);
    peer.server.assertClean();
  });

  it("splits a text over Discord's 2000-character limit into messages it sends one by one", async () => {
    const receipt = await adapter.send(dm, { text: "a".repeat(2500) });

    const sent = peer.visible();
    expect(sent.map((message) => message.text.length)).toEqual([2000, 500]);
    // The receipt names only the first part.
    expect(receipt.messageId).toBe(sent[0]?.id);
    peer.server.assertClean();
  });
});
