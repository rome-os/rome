import { describe, expect, it } from "@rstest/core";
import { reviveDiscordProfile } from "./integrations/discord.js";
import { reviveFeishuProfile } from "./kinds/feishu/descriptor.js";
import { ownAccountNames } from "./own-account-name.js";
import type { ProfileDisplay, ProfileRecord } from "./types.js";

function registry(
  profile: Record<string, unknown> | null,
  revive: (record: ProfileRecord) => ProfileDisplay = (record) => ({
    displayName: record.displayName as string | undefined,
    handle: record.handle as string | undefined,
    email: undefined,
    avatarUrl: undefined,
  }),
  mentionedBy?: "handle" | "displayName",
) {
  return {
    all: () => [{ id: "conn-1", connectionKind: "discord" }],
    grantOf: async () => (profile ? { profile } : null),
    getDescriptor: () => ({ reviveProfile: revive, mentionedBy }),
  } as unknown as Parameters<typeof ownAccountNames>[0];
}

describe("ownAccountNames", () => {
  it("names the account by its handle without the @, by default", async () => {
    expect(
      await ownAccountNames(registry({ displayName: "Scout (Acme)", handle: "@scout" }))("conn-1"),
    ).toBe("scout");
  });

  it("names the account by its display name where its kind's mention shows that", async () => {
    const profile = { displayName: "Scout", handle: "id-1" };
    expect(await ownAccountNames(registry(profile, undefined, "displayName"))("conn-1")).toBe(
      "Scout",
    );
  });

  it("names a Feishu account by its bot, not its application id", async () => {
    const profile = { appId: "cli_a1b2", botName: "Rome" };
    expect(
      await ownAccountNames(registry(profile, reviveFeishuProfile, "displayName"))("conn-1"),
    ).toBe("Rome");
  });

  it("names a Discord account by its bot's username", async () => {
    const profile = { botId: "1", botUsername: "Rome" };
    expect(await ownAccountNames(registry(profile, reviveDiscordProfile))("conn-1")).toBe("Rome");
  });

  it("answers null for an unknown connection or a profile that names nothing", async () => {
    expect(await ownAccountNames(registry({ handle: "Rome" }))("conn-2")).toBeNull();
    expect(await ownAccountNames(registry(null))("conn-1")).toBeNull();
    expect(await ownAccountNames(registry({}))("conn-1")).toBeNull();
  });
});
