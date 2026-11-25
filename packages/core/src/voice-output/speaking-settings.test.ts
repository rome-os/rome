import { describe, expect, it } from "@rstest/core";
import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  readSpeakingPick,
  readSpeakingSettings,
  VOICE_SPEAKING_SETTING_KEY,
} from "./speaking-settings.js";

const settingsWith = (stored: unknown) =>
  ({
    get: async (key: string) => (key === VOICE_SPEAKING_SETTING_KEY ? stored : null),
  }) as unknown as Pick<SettingsRepository, "get">;

describe("the voice and speed a conversation speaks in", () => {
  it("leaves the voice to Rome Cloud and the pace to the voice until one is picked", async () => {
    expect(await readSpeakingPick(settingsWith(null))).toBeUndefined();
    // Settings still shows what that sounds like.
    expect(await readSpeakingSettings(settingsWith(null))).toEqual({ voice: "Iris", speed: 1 });
  });

  it("speaks as picked, and ignores a stored pick that no longer fits", async () => {
    expect(await readSpeakingPick(settingsWith({ voice: "Reid", speed: 1.2 }))).toEqual({
      voice: "Reid",
      speed: 1.2,
    });
    expect(await readSpeakingPick(settingsWith({ voice: "Gone", speed: 1 }))).toBeUndefined();
  });
});
