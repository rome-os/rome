import { describe, expect, it, rs } from "@rstest/core";

import {
  composioWebhookTarget,
  ensureComposioWebhookRegistered,
  RelayWebhookUnavailableError,
} from "./composio-webhook.js";

describe("ensureComposioWebhookRegistered", () => {
  it("registers Composio at the exact relay deposit URL and stores fresh signing material", async () => {
    const setWebhookUrl = rs.fn().mockResolvedValue({ id: "wh_1", secret: "whsec_1" });
    const set = rs.fn().mockResolvedValue(undefined);

    await expect(
      ensureComposioWebhookRegistered({
        client: { setWebhookUrl },
        appSettings: { set },
        settings: { get: async () => ({ depositUrl: "https://relay.example/h/mailbox" }) },
      }),
    ).resolves.toEqual({ webhookUrl: "https://relay.example/h/mailbox" });

    expect(setWebhookUrl).toHaveBeenCalledExactlyOnceWith("https://relay.example/h/mailbox");
    expect(set).toHaveBeenNthCalledWith(1, "webhookSecret", "whsec_1");
    expect(set).toHaveBeenNthCalledWith(2, "webhookEndpointId", "wh_1");
  });

  it("does not call Composio or mutate local state when Relay is unavailable", async () => {
    const setWebhookUrl = rs.fn();
    const set = rs.fn();

    await expect(
      ensureComposioWebhookRegistered({
        client: { setWebhookUrl },
        appSettings: { set },
        settings: { get: async () => null },
      }),
    ).rejects.toBeInstanceOf(RelayWebhookUnavailableError);

    expect(setWebhookUrl).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTPS relay deposit URL before registering it with Composio", async () => {
    const setWebhookUrl = rs.fn();

    await expect(
      ensureComposioWebhookRegistered({
        client: { setWebhookUrl },
        appSettings: { set: rs.fn() },
        settings: { get: async () => ({ depositUrl: "http://relay.example/h/mailbox" }) },
      }),
    ).rejects.toThrow("must use HTTPS");

    expect(setWebhookUrl).not.toHaveBeenCalled();
  });
});

describe("composioWebhookTarget", () => {
  // The answer is kept per relay mailbox, so each case uses its own.
  const relay = (mailbox: string) => ({
    get: async () => ({ depositUrl: `https://relay.example/h/${mailbox}` }),
  });

  it("answers ours when the project's webhook is this relay mailbox", async () => {
    const getWebhookUrl = rs.fn().mockResolvedValue("https://relay.example/h/ours");
    await expect(
      composioWebhookTarget({ client: { getWebhookUrl }, settings: relay("ours") }),
    ).resolves.toBe("ours");
  });

  it("answers elsewhere when another URL holds the project's webhook", async () => {
    const getWebhookUrl = rs.fn().mockResolvedValue("https://relay.example/h/other-rome");
    await expect(
      composioWebhookTarget({ client: { getWebhookUrl }, settings: relay("mine") }),
    ).resolves.toBe("elsewhere");
  });

  it("answers none when the project has no webhook", async () => {
    const getWebhookUrl = rs.fn().mockResolvedValue(null);
    await expect(
      composioWebhookTarget({ client: { getWebhookUrl }, settings: relay("none") }),
    ).resolves.toBe("none");
  });

  it("answers unknown, without keeping it, when Composio or the URL cannot be read", async () => {
    const getWebhookUrl = rs
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("https://relay.example/h/elsewhere-later");
    const input = { client: { getWebhookUrl }, settings: relay("unknown") };
    await expect(composioWebhookTarget(input)).resolves.toBe("unknown");
    await expect(composioWebhookTarget(input)).resolves.toBe("unknown");
    await expect(composioWebhookTarget(input)).resolves.toBe("elsewhere");
    await expect(composioWebhookTarget({ client: null, settings: relay("unknown") })).resolves.toBe(
      "unknown",
    );
  });

  it("keeps the answer briefly, and drops it once this instance registers", async () => {
    const getWebhookUrl = rs
      .fn()
      .mockResolvedValueOnce("https://relay.example/h/other-rome")
      .mockResolvedValueOnce("https://relay.example/h/cached");
    const settings = relay("cached");
    const now = 1_000_000;
    await expect(composioWebhookTarget({ client: { getWebhookUrl }, settings, now })).resolves.toBe(
      "elsewhere",
    );
    await expect(
      composioWebhookTarget({ client: { getWebhookUrl }, settings, now: now + 60_000 }),
    ).resolves.toBe("elsewhere");
    expect(getWebhookUrl).toHaveBeenCalledTimes(1);

    await ensureComposioWebhookRegistered({
      client: { setWebhookUrl: rs.fn().mockResolvedValue({ id: "wh_1", secret: "whsec_1" }) },
      appSettings: { set: rs.fn() },
      settings,
    });
    await expect(
      composioWebhookTarget({ client: { getWebhookUrl }, settings, now: now + 61_000 }),
    ).resolves.toBe("ours");
    expect(getWebhookUrl).toHaveBeenCalledTimes(2);
  });
});
