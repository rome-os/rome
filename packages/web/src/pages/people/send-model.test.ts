import { describe, expect, it } from "@rstest/core";
import { defaultSendAccount, type LinkedAccount, type TimelineEntry } from "@rome/api-types/people";
import {
  ALL_ACCOUNTS,
  accountHandle,
  accountSegments,
  segmentAccount,
  segmentEntries,
  segmentOutbox,
} from "./send-model";

// The shape of the person page's two views. What is under test is the one rule
// the design turns on — a segment names an account, not a channel — and the two
// narrowings that follow from it, each over the key its noun actually carries.

function account(over: Partial<LinkedAccount> & Pick<LinkedAccount, "channel">): LinkedAccount {
  return {
    channelUserId: "u1",
    displayName: "someone",
    send: "yes",
    latestAt: null,
    ...over,
  };
}

describe("accountSegments", () => {
  it("labels a segment with its channel when the channel tells it apart", () => {
    const segments = accountSegments([
      account({ channel: "whatsapp", channelUserId: "6591881123@s.whatsapp.net" }),
      account({ channel: "telegram", channelUserId: "418820113" }),
    ]);

    expect(segments.map((segment) => segment.handle)).toEqual([null, null]);
    expect(segments.map((segment) => segment.value)).toEqual([
      "whatsapp:6591881123@s.whatsapp.net",
      "telegram:418820113",
    ]);
  });

  it("labels with the handle where two segments would otherwise name one channel", () => {
    // The whole reason a segment is an account and not a channel: two WhatsApp
    // numbers would give two segments both saying "WhatsApp", and picking one
    // would be picking blind.
    const segments = accountSegments([
      account({ channel: "whatsapp", channelUserId: "6591881123@s.whatsapp.net" }),
      account({ channel: "whatsapp", channelUserId: "14155550100@s.whatsapp.net" }),
      account({ channel: "telegram", channelUserId: "418820113" }),
    ]);

    expect(segments.map((segment) => segment.handle)).toEqual([
      "+6591881123",
      "+1 (415) 555-0100",
      null,
    ]);
  });

  it("never mints a value the merged segment could collide with", () => {
    const segments = accountSegments([account({ channel: "telegram" })]);
    expect(segments.every((segment) => segment.value !== ALL_ACCOUNTS)).toBe(true);
  });
});

describe("accountHandle", () => {
  it("renders a WhatsApp jid as the number a guardian would recognize", () => {
    expect(accountHandle({ channel: "whatsapp", channelUserId: "6591881123@s.whatsapp.net" })).toBe(
      "+6591881123",
    );
  });

  it("leaves a channel with no phone shape its own identifier", () => {
    expect(accountHandle({ channel: "telegram", channelUserId: "418820113" })).toBe("418820113");
  });
});

describe("segmentAccount", () => {
  const accounts = [account({ channel: "whatsapp" }), account({ channel: "telegram" })];
  const segments = accountSegments(accounts);

  it("answers null for the merged segment", () => {
    expect(segmentAccount(segments, ALL_ACCOUNTS)).toBeNull();
  });

  it("answers null for an account the person no longer holds", () => {
    // A merge or an unlink can take the segmented account away while the view
    // sits open. Falling back to the merged view is the only honest answer —
    // scoping to an account nobody holds would show an empty history under a
    // heading naming somebody else's address.
    expect(segmentAccount(segments, "discord:gone")).toBeNull();
  });
});

describe("segmentEntries", () => {
  const entries: TimelineEntry[] = [
    { source: "whatsapp", timestamp: 20, body: "wa", direction: "inbound", ref: "a" },
    { source: "telegram", timestamp: 10, body: "tg", direction: "inbound", ref: "b" },
  ];

  it("shows everything on the merged segment", () => {
    expect(segmentEntries(entries, null)).toHaveLength(2);
  });

  it("narrows to the segment's channel, which is all an entry names", () => {
    const scoped = segmentEntries(entries, account({ channel: "telegram" }));
    expect(scoped.map((entry) => entry.body)).toEqual(["tg"]);
  });
});

describe("segmentOutbox", () => {
  const messages = [
    {
      id: "1",
      channel: "whatsapp",
      channelUserId: "a",
      text: "one",
      timestamp: 1,
      state: "sending" as const,
      ref: null,
      error: null,
    },
    {
      id: "2",
      channel: "whatsapp",
      channelUserId: "b",
      text: "two",
      timestamp: 2,
      state: "sending" as const,
      ref: null,
      error: null,
    },
  ];

  it("narrows by the account itself, which an outbox row does name", () => {
    // Unlike a timeline entry. Two accounts on one channel therefore share a
    // history under either segment and keep their outboxes apart, which is the
    // half of the pair that can be told apart.
    const scoped = segmentOutbox(messages, account({ channel: "whatsapp", channelUserId: "b" }));
    expect(scoped.map((message) => message.text)).toEqual(["two"]);
  });
});

describe("the account a composer opens on", () => {
  it("is the contract's, and it is the sendable one heard from most recently", () => {
    // Not restated here — `defaultSendAccount` is the contract's function, and a
    // second rule in the dashboard would be a second answer to who receives a
    // message. This pins that the page's inputs reach it in the shape it wants.
    const accounts = [
      account({ channel: "whatsapp", channelUserId: "old", latestAt: 100 }),
      account({ channel: "telegram", channelUserId: "recent", latestAt: 900 }),
      account({ channel: "linkedin", channelUserId: "newest", latestAt: 999, send: "unsupported" }),
    ];
    expect(defaultSendAccount(accounts)?.channelUserId).toBe("recent");
  });

  it("is null when nothing is sendable, which is a reason to render and not an empty box", () => {
    expect(defaultSendAccount([account({ channel: "linkedin", send: "unsupported" })])).toBeNull();
  });
});
