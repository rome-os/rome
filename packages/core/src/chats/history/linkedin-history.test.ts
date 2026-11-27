import { describe, expect, it, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb, identityConnectionKindOf } from "../../test/db.js";
import { createIdentity, type Identity } from "../../identity/identity.js";
import { linkedInHistoryMessage } from "./linkedin-history.js";
import type { LinkedInHistoryMessage } from "../../connections/kinds/linkedin/linkedin-sync.js";
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
 * A person who holds a LinkedIn account is recognised on their mirrored
 * messages with nothing else wired up. That only holds if both sides name the
 * account the same way: the bare member id.
 */
describe("LinkedIn message addressing", () => {
  let testDb: TestDb;
  let identity: Identity;

  beforeEach(() => {
    testDb = createTestDb();
    identity = createIdentity(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("maps a message to the member id `linkedin_participants` is keyed by", async () => {
    const [message] = await readHistory([historyMessage()]);
    expect(message.senderId).toBe("ACoAAAda0001");
  });

  it("resolves a participant to the person holding their account", async () => {
    const ada = await identity.createPerson({
      name: "Ada Lovelace",
      accounts: [{ platform: "linkedin", accountId: "ACoAAAda0001" }],
    });

    const [message] = await readHistory([historyMessage()]);
    const person = await identity.personOf({ platform: "linkedin", accountId: message.senderId });

    expect(person?.id).toBe(ada.id);
  });

  it("resolves a participant nobody holds to nobody", async () => {
    const [message] = await readHistory([historyMessage()]);
    expect(
      await identity.personOf({ platform: "linkedin", accountId: message.senderId }),
    ).toBeNull();
  });

  // A profile URL with a vanity handle carries no member id. Falling back to
  // the URL still names the sender by an account rather than stranding them.
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
