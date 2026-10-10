import { describe, expect, it } from "@rstest/core";
import type { TFunction } from "i18next";
import { CHANNEL_META, channelLabel } from "./channel-meta";

// What a channel is called in front of a person. Channels are open — a Rome App
// brings its own — so the cases that matter are the ones no roster covers.

/** The real lookup, minus i18n: a key resolves to its own last segment, so a
 *  missing entry is visible as the key rather than as a plausible label. */
const t = ((key: string) => key.split(".").at(-1)) as unknown as TFunction<"people">;

describe("channelLabel", () => {
  it("names the network, not the credential Rome reads it through", () => {
    expect(channelLabel(t, "wechat_user")).toBe(channelLabel(t, "wechat"));
    expect(channelLabel(t, "telegram_user")).toBe(channelLabel(t, "telegram"));
  });

  it("titles a channel it has no entry for rather than printing its id", () => {
    expect(channelLabel(t, "city_lights")).toBe("City Lights");
    expect(channelLabel(t, "rome-app")).toBe("Rome App");
  });

  it("titles an id on every separator a channel name can carry", () => {
    // A channel name is any non-empty string without a colon (isChannelIdentifier),
    // so the separators an app picks are its own.
    expect(channelLabel(t, "moonlight.wall")).toBe("Moonlight Wall");
    expect(channelLabel(t, "moonlight/wall")).toBe("Moonlight Wall");
    expect(channelLabel(t, "moonlight wall 2")).toBe("Moonlight Wall 2");
  });

  it("keeps an id with no name in it rather than rendering an empty badge", () => {
    expect(channelLabel(t, "__")).toBe("__");
  });

  it("carries a localized name for every channel it knows", () => {
    for (const [channel, meta] of Object.entries(CHANNEL_META)) {
      expect(meta.labelKey, channel).toMatch(/^channels\./);
    }
  });
});
