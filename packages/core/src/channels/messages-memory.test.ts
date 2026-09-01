import { describe, expect, it } from "@rstest/core";
import type { TimelineEntry } from "@rome/api-types/people";
import { memoryMessages, type HeldMessage } from "./messages-memory.js";
import { testMessagesContract, WHOLE_HISTORY } from "./messages-contract.js";

// The reference store, and the contract suite proved against it: a suite that
// passed nothing would enroll every adapter and assert none of them.

const PHONE = "1555@s.whatsapp.net";
const LID = "77@lid";
const MEMBER = "ACoAA1";
// A group: addressed by the group and by nobody on it, so its messages are
// held at the group rather than at whoever spoke — which is how a mirror keys
// one, a WhatsApp group message hanging off the group's chat.
const GROUP = "wa-group";
// Two people on that group. No message of it names either, which is what makes
// a group unreachable from an account read rather than merely filtered out of
// one.
const IN_GROUP_ONE = "9998@s.whatsapp.net";
const IN_GROUP_TWO = "9997@s.whatsapp.net";
// The thread the LinkedIn messages below were said in: a conversation named by
// something other than the address they arrived at, the way a LinkedIn message
// hangs off a thread rather than off a member.
const LI_THREAD = "li-thread-1";

const entry = (
  source: string,
  timestamp: number,
  ref: string,
  direction: "inbound" | "outbound" = "inbound",
): TimelineEntry => ({ source, timestamp, ref, direction, body: `${ref}@${timestamp}` });

const held: HeldMessage[] = [
  { channel: "whatsapp", address: PHONE, entry: entry("whatsapp", 100, "wa:a") },
  { channel: "whatsapp", address: PHONE, entry: entry("whatsapp", 300, "wa:c", "outbound") },
  // The same second as wa:c, on the account's other address: the direction
  // settles the tie, and both have to survive a page boundary.
  { channel: "whatsapp", address: LID, entry: entry("whatsapp", 300, "wa:d") },
  { channel: "whatsapp", address: PHONE, entry: entry("whatsapp", 500, "wa:e") },
  {
    channel: "linkedin",
    address: MEMBER,
    conversation: LI_THREAD,
    entry: entry("linkedin", 200, "li:b"),
  },
  {
    channel: "linkedin",
    address: MEMBER,
    conversation: LI_THREAD,
    entry: entry("linkedin", 400, "li:f", "outbound"),
  },
  // Out of every scope below: another account on the same channel, and the
  // same string as a WhatsApp address on a channel that is not WhatsApp.
  { channel: "whatsapp", address: "9999@s.whatsapp.net", entry: entry("whatsapp", 600, "wa:x") },
  { channel: "linkedin", address: PHONE, entry: entry("linkedin", 700, "li:x") },
  // The group, reachable only by naming it. Every line of it is held at the
  // group, so it names the conversation by arriving there — which is what a
  // message with no conversation of its own says.
  { channel: "whatsapp", address: GROUP, entry: entry("whatsapp", 800, "wa:g1") },
  { channel: "whatsapp", address: GROUP, entry: entry("whatsapp", 900, "wa:g2") },
  // The same second as wa:g2; the direction settles the tie.
  { channel: "whatsapp", address: GROUP, entry: entry("whatsapp", 900, "wa:g3", "outbound") },
  { channel: "whatsapp", address: GROUP, entry: entry("whatsapp", 1000, "wa:g4") },
];

const accounts = [
  { channel: "whatsapp", addresses: [PHONE, LID] },
  { channel: "linkedin", addresses: [MEMBER] },
];

testMessagesContract("memoryMessages", () => ({
  messages: memoryMessages(held),
  accounts,
  silent: [{ channel: "whatsapp", addresses: ["4444@s.whatsapp.net"] }],
  conversation: { channel: "whatsapp", id: GROUP },
  silentConversation: { channel: "whatsapp", id: "wa-quiet-group" },
}));

describe("memoryMessages", () => {
  const messages = memoryMessages(held);

  it("merges every address of every account into one newest-first history", async () => {
    const page = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(page.map((e) => e.ref)).toEqual(["wa:e", "li:f", "wa:c", "wa:d", "li:b", "wa:a"]);
  });

  it("scopes by the channel and the address together", async () => {
    const page = await messages.read({
      accounts: [{ channel: "whatsapp", addresses: [PHONE] }],
      limit: WHOLE_HISTORY,
    });
    expect(page.map((e) => e.ref)).toEqual(["wa:e", "wa:c", "wa:a"]);
  });

  it("answers a message once when two accounts name its address", async () => {
    const shared = [
      { channel: "whatsapp", addresses: [PHONE] },
      { channel: "whatsapp", addresses: [PHONE, LID] },
    ];
    expect(await messages.count(shared)).toBe(4);
  });

  it("answers a conversation nothing in it is addressed by", async () => {
    const page = await messages.readConversation({
      conversation: { channel: "whatsapp", id: GROUP },
      limit: WHOLE_HISTORY,
    });
    expect(page.map((e) => e.ref)).toEqual(["wa:g4", "wa:g3", "wa:g2", "wa:g1"]);
  });

  it("answers a group's messages to no account read", async () => {
    // Every account the fixture holds one for, and two people on the group
    // besides. A group message is held at the group, so no address names one —
    // which is the reason the account reads answer direct threads only.
    const everyone = [
      ...accounts,
      { channel: "whatsapp", addresses: [IN_GROUP_ONE, IN_GROUP_TWO] },
    ];
    const held = (await messages.read({ accounts: everyone, limit: WHOLE_HISTORY })).map(
      (e) => e.ref,
    );
    for (const ref of ["wa:g1", "wa:g2", "wa:g3", "wa:g4"]) expect(held).not.toContain(ref);
  });

  it("reads a conversation named by something other than the address", async () => {
    const page = await messages.readConversation({
      conversation: { channel: "linkedin", id: LI_THREAD },
      limit: WHOLE_HISTORY,
    });
    expect(page.map((e) => e.ref)).toEqual(["li:f", "li:b"]);
    // And the same messages still reach the member's own account read: a
    // direct thread is one history named two ways, not two histories.
    const member = [{ channel: "linkedin", addresses: [MEMBER] }];
    expect((await messages.read({ accounts: member, limit: WHOLE_HISTORY })).map((e) => e.ref)) //
      .toEqual(["li:f", "li:b"]);
  });

  it("reads a direct conversation under the address that names it", async () => {
    const page = await messages.readConversation({
      conversation: { channel: "whatsapp", id: PHONE },
      limit: WHOLE_HISTORY,
    });
    expect(page.map((e) => e.ref)).toEqual(["wa:e", "wa:c", "wa:a"]);
  });

  it("scopes a conversation by the channel and the id together", async () => {
    expect(
      await messages.readConversation({
        conversation: { channel: "linkedin", id: GROUP },
        limit: WHOLE_HISTORY,
      }),
    ).toEqual([]);
  });

  it("holds nothing for an empty scope", async () => {
    expect(await messages.latest([])).toBeNull();
    expect(await messages.count([])).toBe(0);
    expect(await messages.read({ accounts: [], limit: WHOLE_HISTORY })).toEqual([]);
  });
});
