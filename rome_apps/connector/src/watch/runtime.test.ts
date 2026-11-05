import { describe, expect, it } from "@rstest/core";
import type { ActiveTrigger } from "../api/composio-client.js";
import { GMAIL_TRIGGER_CONFIG } from "./catalog.js";
import { armsGmailWatch } from "./runtime.js";

const trigger = (over: Partial<ActiveTrigger> = {}): ActiveTrigger => ({
  triggerInstanceId: "ti_1",
  triggerName: "GMAIL_NEW_GMAIL_MESSAGE",
  connectedAccountIds: ["ca_me", "uuid-me"],
  triggerConfig: { ...GMAIL_TRIGGER_CONFIG, interval: 1 },
  updatedAt: "2026-11-04T00:00:00Z",
  ...over,
});

describe("armsGmailWatch", () => {
  it("counts the new-mail trigger for the connected account with this app's labels", () => {
    expect(armsGmailWatch(trigger(), "ca_me")).toBe(true);
    expect(armsGmailWatch(trigger(), "uuid-me")).toBe(true);
  });

  it("does not count one for another account, another label, or another trigger", () => {
    expect(armsGmailWatch(trigger(), "ca_other")).toBe(false);
    expect(armsGmailWatch(trigger({ triggerConfig: { labelIds: "SENT" } }), "ca_me")).toBe(false);
    expect(armsGmailWatch(trigger({ triggerConfig: {} }), "ca_me")).toBe(false);
    expect(armsGmailWatch(trigger({ triggerName: "GMAIL_EMAIL_SENT" }), "ca_me")).toBe(false);
  });
});
