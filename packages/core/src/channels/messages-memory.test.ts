import { describe, expect, it } from "@rstest/core";
import type { TimelineEntry } from "@rome/api-types/people";
import { memoryMessages, type HeldMessage } from "./messages-memory.js";
import { testMessagesContract, WHOLE_HISTORY } from "./messages-contract.js";

// The reference store, and the contract suite proved against it: a suite that
// passed nothing would enroll every adapter and assert none of them.

const PHONE = "1555@s.whatsapp.net";
const LID = "77@lid";
const MEMBER = "ACoAA1";

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
];

const accounts = [
  { channel: "whatsapp", addresses: [PHONE, LID] },
  { channel: "linkedin", addresses: [MEMBER] },
];

testMessagesContract("memoryMessages", () => ({
  messages: memoryMessages(held),
  accounts,
  silent: [{ channel: "whatsapp", addresses: ["4444@s.whatsapp.net"] }],
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

  it("holds nothing for an empty scope", async () => {
    expect(await messages.latest([])).toBeNull();
    expect(await messages.count([])).toBe(0);
    expect(await messages.read({ accounts: [], limit: WHOLE_HISTORY })).toEqual([]);
  });
});
