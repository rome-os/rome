import { describe, expect, it } from "@rstest/core";
import type { TimelineEntry } from "@rome/api-types/people";
import { memoryMessages, type HeldMessage } from "./messages-memory.js";
import { testMessagesContract, WHOLE_HISTORY } from "./messages-contract.js";

// The reference store, and the contract suite proved against it: a suite that
// passed nothing would enroll every adapter and assert none of them.

const PHONE = "1555@s.whatsapp.net";
const LID = "77@lid";
const MEMBER = "ACoAA1";
// A group: addressed by neither of the two who speak in it, so its messages
// name the conversation themselves.
const GROUP = "wa-group";
const IN_GROUP_ONE = "9998@s.whatsapp.net";
const IN_GROUP_TWO = "9997@s.whatsapp.net";

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
  { channel: "linkedin", address: MEMBER, entry: entry("linkedin", 200, "li:b") },
  { channel: "linkedin", address: MEMBER, entry: entry("linkedin", 400, "li:f", "outbound") },
  // Out of every scope below: another account on the same channel, and the
  // same string as a WhatsApp address on a channel that is not WhatsApp.
  { channel: "whatsapp", address: "9999@s.whatsapp.net", entry: entry("whatsapp", 600, "wa:x") },
  { channel: "linkedin", address: PHONE, entry: entry("linkedin", 700, "li:x") },
  // The group, reachable only by naming it. Two of its lines arrived at the
  // address that said them and name the conversation, and two name it by
  // arriving at the group itself — which is what a message with no conversation
  // of its own says.
  {
    channel: "whatsapp",
    address: IN_GROUP_ONE,
    conversation: GROUP,
    entry: entry("whatsapp", 800, "wa:g1"),
  },
  {
    channel: "whatsapp",
    address: IN_GROUP_TWO,
    conversation: GROUP,
    entry: entry("whatsapp", 900, "wa:g2"),
  },
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

  it("answers a conversation to no account that names one of its speakers", async () => {
    const speakers = [
      { channel: "whatsapp", addresses: [IN_GROUP_ONE, IN_GROUP_TWO] },
      ...accounts,
    ];
    const page = await messages.read({ accounts: speakers, limit: WHOLE_HISTORY });
    // Each speaker's own line reaches the address it arrived at — a memory
    // store subtracts nothing — and the two the group itself holds reach
    // nobody, which is what an address that names no account means.
    expect(page.map((e) => e.ref)).not.toContain("wa:g3");
    expect(page.map((e) => e.ref)).not.toContain("wa:g4");
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
