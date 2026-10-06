import { describe, expect, it, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { linkedInHistoryMessage } from "./linkedin-history.js";
import type { LinkedInHistoryMessage } from "./linkedin-sync.js";
import type { ChannelMessage } from "@rome-os/app-runtime";

function historyMessage(overrides: Partial<LinkedInHistoryMessage> = {}): LinkedInHistoryMessage {
  return {
    messageId: "m1",
    threadId: "2-abc==",
    threadName: "Ada Lovelace",
    sentAt: new Date("2026-08-19T20:00:00Z"),
    senderName: "Ada Lovelace",
    senderProfileUrl: "https://www.linkedin.com/in/ACoAAAda0001/",
    senderIsSelf: false,
    text: "hello",
    subject: null,
    ...overrides,
  };
}

/** Mirrored rows as the channel reads them back. */
async function readHistory(rows: LinkedInHistoryMessage[]): Promise<ChannelMessage[]> {
  return rows.map(linkedInHistoryMessage);
}

/**
 * The promotion bridge: a mirrored participant that a guardian turned into a
 * person is recognised on their next message with nothing else wired up. That
 * only holds if both sides name the account the same way — the bare member id.
 */
describe("LinkedIn message addressing", () => {
  let testDb: TestDb;
  let people: PersonMappingRepository;

  beforeEach(() => {
    testDb = createTestDb();
    people = new PersonMappingRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("maps a message to the member id `linkedin_participants` is keyed by", async () => {
    const [message] = await readHistory([historyMessage()]);
    expect(message.senderId).toBe("ACoAAAda0001");
  });

  it("resolves a promoted participant to their person", async () => {
    await people.create({
      displayName: "Ada Lovelace",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "linkedin", channelUserId: "ACoAAAda0001" }],
    });

    const [message] = await readHistory([historyMessage()]);
    const person = await people.findByChannelUser("linkedin", message.senderId);

    expect(person?.id).toBe("ada-lovelace");
  });

  it("does not resolve a participant nobody promoted", async () => {
    const [message] = await readHistory([historyMessage()]);
    expect(await people.findByChannelUser("linkedin", message.senderId)).toBeNull();
  });

  // The guardian's own mapping is conferred at connect time from their public
  // profile URL, which carries a vanity handle and no member id. Falling back to
  // the URL keeps that mapping resolving instead of stranding it.
  it("falls back to the profile URL when it carries no member id", async () => {
    const [message] = await readHistory([
      historyMessage({ senderProfileUrl: "https://www.linkedin.com/in/ada-lovelace/" }),
    ]);
    expect(message.senderId).toBe("https://www.linkedin.com/in/ada-lovelace/");
  });

  it("falls back to a sentinel when the sender has no profile URL at all", async () => {
    const [them] = await readHistory([historyMessage({ senderProfileUrl: null })]);
    expect(them.senderId).toBe("linkedin:unknown");

    const [me] = await readHistory([
      historyMessage({ senderProfileUrl: null, senderIsSelf: true }),
    ]);
    expect(me.senderId).toBe("linkedin:self");
  });
});

describe("linkedInHistoryMessage", () => {
  it("leaves a sender the mirror recorded no name for unnamed", () => {
    expect(
      linkedInHistoryMessage(historyMessage({ senderName: null })).senderDisplayName,
    ).toBeUndefined();
    expect(linkedInHistoryMessage(historyMessage()).senderDisplayName).toBe("Ada Lovelace");
  });
});
