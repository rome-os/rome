import { describe, expect, it } from "@rstest/core";
import type { ReplyOutcome } from "../../../channels/delivery/reply.js";
import { checkDelivery, type DeliveryCheck } from "./invariants.js";
import { MessageStore } from "./peer.js";

const CONVERSATION = "c";

/**
 * A reply whose parts were `sent` and which the platform shows as `shown`, one
 * message per part unless `shown` says otherwise.
 */
function reply({
  source,
  sent,
  shown = sent,
  maxPartLength = 100,
}: {
  source: string;
  sent: string[];
  shown?: string[];
  maxPartLength?: number;
}) {
  const store = new MessageStore();
  for (const [index, text] of shown.entries())
    store.add({ id: String(index + 1), conversation: CONVERSATION, from: "rome", text });
  const outcome: ReplyOutcome = {
    status: "delivered",
    parts: sent.map((text, index) => ({
      block: 0,
      text,
      receipt: { messageId: String(index + 1), conversationId: CONVERSATION },
      state: "settled",
    })),
  };
  const input: DeliveryCheck = {
    source,
    outcome,
    peer: store,
    conversation: CONVERSATION,
    maxPartLength,
  };
  return { store, input };
}

const verdicts = (input: DeliveryCheck) =>
  Object.fromEntries(checkDelivery(input).map((check) => [check.id, check.ok]));

describe("checkDelivery", () => {
  it("holds every invariant for a reply the platform shows as written", () => {
    const { input } = reply({ source: "one. two.", sent: ["one. ", "two."] });
    expect(verdicts({ ...input })).toEqual({
      "final-text-is-the-reply": true,
      "one-message-per-part": true,
      "receipts-name-what-is-shown": true,
      "every-message-fits": true,
      "text-never-goes-back": true,
    });
  });

  it("leaves a reply that reports itself as differing out of the final-text rule", () => {
    const { input } = reply({ source: "aaaa", sent: ["aaaa bbbb"] });
    expect(verdicts(input)["final-text-is-the-reply"]).toBe(false);

    const diverged = { ...input, outcome: { ...input.outcome, diverged: true as const } };
    expect(verdicts(diverged)["final-text-is-the-reply"]).toBe(true);
  });

  it("tolerates the whitespace a platform trims at a message's edges, and nothing else", () => {
    const trimmed = reply({
      source: "one. two. ",
      sent: ["one. ", "two. "],
      shown: ["one.", "two."],
    });
    expect(verdicts(trimmed.input)).toMatchObject({
      "final-text-is-the-reply": true,
      "receipts-name-what-is-shown": true,
    });

    const altered = reply({
      source: "one. two. ",
      sent: ["one. ", "two. "],
      shown: ["one.", "tw0."],
    });
    expect(verdicts(altered.input)).toMatchObject({
      "final-text-is-the-reply": false,
      "receipts-name-what-is-shown": false,
    });
  });

  it("breaks when the messages leave out or repeat the reply's text", () => {
    const missing = reply({
      source: "one. two.",
      sent: ["one. ", "two."],
      shown: ["one.", "two."],
    });
    missing.store.edit("2", "");
    expect(verdicts(missing.input)["final-text-is-the-reply"]).toBe(false);

    const repeated = reply({ source: "one.", sent: ["one."], shown: ["one.", "one."] });
    const [broken] = checkDelivery(repeated.input);
    expect(broken).toMatchObject({ id: "final-text-is-the-reply", ok: false });
    expect(broken?.detail).toContain('shows "one.one."');
  });

  it("breaks when a part shows twice", () => {
    const { input } = reply({ source: "one.", sent: ["one."], shown: ["one.", "one."] });
    expect(checkDelivery(input).find((check) => check.id === "one-message-per-part")).toEqual({
      id: "one-message-per-part",
      ok: false,
      detail: "2 messages for 1 accepted and 0 unknown parts",
    });
  });

  it("lets a part whose create is unknown show once", () => {
    const { input } = reply({ source: "one.", sent: ["one."], shown: ["one.", "one."] });
    const unknown: ReplyOutcome = {
      status: "unknown",
      parts: [...input.outcome.parts, { block: 0, text: "one.", state: "unknown" }],
    };
    expect(verdicts({ ...input, outcome: unknown })["one-message-per-part"]).toBe(true);
  });

  it("breaks when a receipt names a message that shows other text", () => {
    const { input } = reply({ source: "one.", sent: ["one."], shown: ["two."] });
    expect(verdicts(input)["receipts-name-what-is-shown"]).toBe(false);
  });

  it("breaks when a message exceeds the platform's limit", () => {
    const { input } = reply({ source: "abcdef", sent: ["abcdef"], maxPartLength: 5 });
    expect(verdicts(input)["every-message-fits"]).toBe(false);
  });

  it("breaks when an edit takes back text the message showed", () => {
    const { store, input } = reply({ source: "one two", sent: ["one two"] });
    store.edit("1", "one two three");
    expect(verdicts(input)["text-never-goes-back"]).toBe(true);
    store.edit("1", "one too");
    expect(checkDelivery(input).find((check) => check.id === "text-never-goes-back")?.detail).toBe(
      'message 1 went from "one two three" to "one too"',
    );
  });

  it("judges the reply's text only when the reply was delivered", () => {
    const { input } = reply({ source: "one. two.", sent: ["one. "], shown: ["one."] });
    const partial: ReplyOutcome = { ...input.outcome, status: "partial" };
    expect(verdicts({ ...input, outcome: partial })["final-text-is-the-reply"]).toBe(true);
  });
});
