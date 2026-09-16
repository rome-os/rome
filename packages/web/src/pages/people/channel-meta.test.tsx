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

  it("carries a localized name for every channel it knows", () => {
    for (const [channel, meta] of Object.entries(CHANNEL_META)) {
      expect(meta.labelKey, channel).toMatch(/^channels\./);
    }
  });
});
