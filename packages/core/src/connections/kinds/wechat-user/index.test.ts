import { describe, expect, it, rs } from "@rstest/core";
import type { MiddlewareHandler } from "hono";
import type { RuntimeKit } from "../../types.js";
import { WECHAT_USER_KIND, wechatUser } from "./index.js";
import type { WechatUserRuntime } from "./wechat-user.js";

const letIn: MiddlewareHandler = (_c, next) => next();

describe("wechatUser", () => {
  it("gives WeChat personal the client runtime boot shares with the channel list", async () => {
    const bridgeCommand = rs.fn(async () => [
      {
        username: "wxid_friend",
        displayName: "A Friend",
        type: "private",
        unread: 0,
        lastMessage: { content: "hi", createdAt: "2026-10-01T00:00:00.000Z" },
      },
    ]);
    const runtime = { bridgeCommand } as unknown as WechatUserRuntime;

    const { descriptor } = wechatUser({ runtime, guardianOnly: letIn });

    const kit = {
      connectionId: "conn-wechat-user",
      persist: async () => {},
      registerIngress: () => () => {},
    } satisfies RuntimeKit;
    expect(descriptor?.connectionKind).toBe(WECHAT_USER_KIND);
    const talker = descriptor!.capabilities.talker!.build(
      { material: { wxid: "wxid_guardian" }, expiresAt: "never" },
      kit,
    );
    const page = await talker.directory!.listConversations({ limit: 10 });

    expect(page.conversations.map((c) => c.ref.chatId)).toEqual(["wxid_friend"]);
    expect(bridgeCommand).toHaveBeenCalled();
  });

  it("offers no WeChat personal connection without a runtime, but still answers the app routes", async () => {
    const mount = wechatUser({ guardianOnly: letIn });

    expect(mount.descriptor).toBeNull();
    expect(mount.routes).toBeDefined();
  });
});
