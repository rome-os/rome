import { describe, expect, it } from "@rstest/core";
import { ENABLE_REPLY_STREAMING_SETTING_KEY, replyStreamingSwitch } from "./streaming-switch.js";

const settingsWith = (value: unknown) => ({
  get: async <T = unknown>(key: string): Promise<T | null> =>
    key === ENABLE_REPLY_STREAMING_SETTING_KEY ? (value as T) : null,
});

describe("replyStreamingSwitch", () => {
  it("is off until the setting is stored", async () => {
    expect(await replyStreamingSwitch(settingsWith(null))()).toBe(false);
  });

  it("is on only for the boolean true", async () => {
    expect(await replyStreamingSwitch(settingsWith(true))()).toBe(true);
    for (const value of [false, "true", 1, {}, []])
      expect(await replyStreamingSwitch(settingsWith(value))()).toBe(false);
  });

  it("reads the setting on every call, so a change applies to the next reply", async () => {
    let stored: unknown = false;
    const streaming = replyStreamingSwitch({ get: async <T = unknown>() => stored as T });
    expect(await streaming()).toBe(false);
    stored = true;
    expect(await streaming()).toBe(true);
    stored = false;
    expect(await streaming()).toBe(false);
  });

  it("counts a setting it cannot read as off", async () => {
    const streaming = replyStreamingSwitch({
      get: async () => {
        throw new Error("database is locked");
      },
    });
    expect(await streaming()).toBe(false);
  });
});
