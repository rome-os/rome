import { describe, expect, it, rs } from "@rstest/core";

import {
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
