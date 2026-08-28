import { describe, expect, it } from "@rstest/core";
import {
  extractEventType,
  extractTriggerSlug,
  normalizeComposioPayload,
  type SubscriptionEvent,
} from "./normalize.js";

const classification = { provider: "gmail", eventType: "gmail_new_gmail_message" };

describe("extractTriggerSlug", () => {
  it("reads metadata.trigger_slug (V3)", () => {
    expect(extractTriggerSlug({ metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" } })).toBe(
      "GMAIL_NEW_GMAIL_MESSAGE",
    );
  });

  it("returns null for payloads without a trigger_slug", () => {
    expect(extractTriggerSlug({})).toBeNull();
    expect(extractTriggerSlug({ metadata: {} })).toBeNull();
    expect(extractTriggerSlug({ type: "composio.connected_account.expired" })).toBeNull();
  });
});

describe("extractEventType", () => {
  it("reads the V3 payload's `type` discriminant", () => {
    expect(extractEventType({ type: "composio.trigger.message" })).toBe("composio.trigger.message");
    expect(extractEventType({ type: "composio.trigger.disabled" })).toBe(
      "composio.trigger.disabled",
    );
  });

  it("returns null when `type` is missing or not a non-empty string", () => {
    expect(extractEventType({})).toBeNull();
    expect(extractEventType({ type: "" })).toBeNull();
    expect(extractEventType({ type: 42 })).toBeNull();
  });
});

describe("normalizeComposioPayload", () => {
  const v3Payload = {
    id: "evt-v3-uuid",
    timestamp: "2026-05-28T00:00:00.000Z",
    type: "composio.trigger.message",
    metadata: {
      trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
    },
    data: { subject: "hello", from: "x@y.com" },
  };

  it("V3 carries `id` as eventId and `data` as the data payload", () => {
    const event = normalizeComposioPayload(
      v3Payload,
      classification,
      "msg_xyz",
      "2026-05-28T00:00:00.000Z",
    );
    expect(event).toEqual<SubscriptionEvent>({
      eventId: "evt-v3-uuid",
      provider: "gmail",
      eventType: "gmail_new_gmail_message",
      receivedAt: "2026-05-28T00:00:00.000Z",
      data: { subject: "hello", from: "x@y.com" },
    });
  });

  it("classification — not body fields — sets provider/eventType", () => {
    const event = normalizeComposioPayload(
      { ...v3Payload, metadata: { trigger_slug: "SLACK_BAD" } },
      classification,
      "msg_xyz",
      "2026-05-28T00:00:00.000Z",
    );
    expect(event.provider).toBe("gmail");
    expect(event.eventType).toBe("gmail_new_gmail_message");
  });

  it("falls back to webhookId when id is absent", () => {
    const event = normalizeComposioPayload(
      { data: { x: 1 } },
      classification,
      "msg_fallback",
      "2026-05-28T00:00:00.000Z",
    );
    expect(event.eventId).toBe("msg_fallback");
  });

  it("data defaults to empty object when missing or non-object", () => {
    expect(
      normalizeComposioPayload({ id: "evt-z" }, classification, "msg_z", "2026-05-28T00:00:00.000Z")
        .data,
    ).toEqual({});
    expect(
      normalizeComposioPayload(
        { id: "evt-z", data: [1, 2] },
        classification,
        "msg_z",
        "2026-05-28T00:00:00.000Z",
      ).data,
    ).toEqual({});
  });
});
