import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import {
  accountRef,
  type AccountDirectory,
  type DirectoryAccount,
  type LinkConflict,
} from "@rome/api-types/people";
import { accountDecisionRoutes } from "./account-decisions.js";
import { accountsRoutes } from "./accounts.js";
import { dismissAccount, type AccountDecisionDeps } from "../../people/account-decisions.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline } from "../../test/seeds.js";
import { channelMappings } from "../../db/schema.js";
import { STRANGER_PERSON_DISPLAY_NAME, STRANGER_PERSON_ID } from "../../constants.js";

// Dismiss and restore are the two writes that move an account between "nobody
// has decided about this" and "the guardian does not want to hear from it".
// They are a state, filed under the stranger sentinel, and these tests pin the
// three things that makes true: the pair of verbs is idempotent, neither of
// them touches an account a real person holds — unlink is that verb — and the
// sentinel the dismissal is stored under never reaches a client.

const TALKING_JID = "15550002222@s.whatsapp.net";
const LINKED_JID = "15550003333@s.whatsapp.net";
const PHONE_JID = "15550009999@s.whatsapp.net";
const LID_JID = "99900099999@lid";
const DISMISSED_SENDER = "tg-spammer";

describe("Account dismiss and restore", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let waPersonId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    // Both routers, because what a write did is only visible in what the
    // directory says afterwards.
    app = new Hono().route("/", accountsRoutes(deps)).route("/", accountDecisionRoutes(deps));

    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: TALKING_JID, notify: "Talky Tina" },
      { jid: LINKED_JID, name: "Alice WA" },
      // One contact the address book reaches two ways, so a write has to land
      // on the account rather than on the address it was named by.
      { jid: PHONE_JID, name: "Split Contact" },
      { jid: LID_JID, phoneNumber: "15550009999" },
    ]);
    await deps.whatsAppStoreRepo.upsertMessages([
      {
        id: "wa-1",
        chatJid: TALKING_JID,
        senderJid: TALKING_JID,
        fromMe: false,
        timestamp: new Date("2026-08-17T10:00:00Z"),
        type: "text",
        text: "hello from tina",
        hasMedia: false,
      },
      {
        id: "wa-2",
        chatJid: LINKED_JID,
        senderJid: LINKED_JID,
        fromMe: false,
        timestamp: new Date("2026-08-17T11:00:00Z"),
        type: "text",
        text: "hello from alice's wa",
        hasMedia: false,
      },
      {
        id: "wa-3",
        chatJid: PHONE_JID,
        senderJid: PHONE_JID,
        fromMe: false,
        timestamp: new Date("2026-08-17T12:00:00Z"),
        type: "text",
        text: "hello from the split contact",
        hasMedia: false,
      },
    ]);

    waPersonId = await deps.personMappingRepo.create({
      displayName: "Wanda Placed",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "whatsapp", channelUserId: LINKED_JID }],
    });

    // An account already dismissed: a sender in the log, filed under the
    // sentinel.
    await deps.sentinelLogRepo.create({
      messageId: "msg-spam-1",
      channel: "telegram",
      channelUserId: DISMISSED_SENDER,
      displayName: "Spammer",
      text: "buy my coin",
      action: "ignored",
    });
    await deps.personMappingRepo.addChannelMapping(
      STRANGER_PERSON_ID,
      "telegram",
      DISMISSED_SENDER,
      "Spammer",
    );
  });

  afterEach(() => testDb.close());

  const decide = (channel: string, channelUserId: string, verb: "dismiss" | "restore") =>
    app.request(`/accounts/${channel}/${encodeURIComponent(channelUserId)}/${verb}`, {
      method: "POST",
    });

  async function decision(
    channel: string,
    channelUserId: string,
    verb: "dismiss" | "restore",
  ): Promise<DirectoryAccount> {
    const res = await decide(channel, channelUserId, verb);
    expect(res.status).toBe(200);
    return (await res.json()) as DirectoryAccount;
  }

  async function fetchPage(query = ""): Promise<AccountDirectory> {
    const res = await app.request(`/accounts${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as AccountDirectory;
  }

  const find = (page: AccountDirectory, ref: string): DirectoryAccount | undefined =>
    page.accounts.find((account) => accountRef(account) === ref);

  /** Every mapping row the pair holds — what "changed nothing" is measured in. */
  const mappingRows = (channel: string, channelUserId: string) =>
    testDb.db
      .select()
      .from(channelMappings)
      .where(
        and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, channelUserId)),
      )
      .all();

  it("moves an unlinked account to dismissed, and repeating the write changes nothing", async () => {
    const first = await decision("whatsapp", TALKING_JID, "dismiss");
    expect(first).toMatchObject({
      channel: "whatsapp",
      channelUserId: TALKING_JID,
      state: "dismissed",
      personId: null,
      personName: null,
    });
    // The row the directory would list, not a bespoke answer: a client
    // re-renders what it decided without re-reading the listing to learn what
    // it now says.
    expect(first).toEqual(find(await fetchPage("?state=dismissed"), `whatsapp:${TALKING_JID}`));

    const stored = mappingRows("whatsapp", TALKING_JID);
    expect(stored).toHaveLength(1);
    expect(stored[0].personId).toBe(STRANGER_PERSON_ID);

    // Idempotent: the second call answers the same state and leaves the same
    // row behind, rather than a second claim on the same account.
    const second = await decision("whatsapp", TALKING_JID, "dismiss");
    expect(second).toEqual(first);
    expect(mappingRows("whatsapp", TALKING_JID)).toEqual(stored);
  });

  it("moves a dismissed account back to unlinked, and repeating the write changes nothing", async () => {
    const first = await decision("telegram", DISMISSED_SENDER, "restore");
    expect(first).toMatchObject({
      channel: "telegram",
      channelUserId: DISMISSED_SENDER,
      state: "unlinked",
      personId: null,
      personName: null,
    });
    // Still observed, and still listed — restoring an account un-decides it,
    // it does not delete what Rome saw.
    expect(first).toEqual(find(await fetchPage(), `telegram:${DISMISSED_SENDER}`));
    expect(mappingRows("telegram", DISMISSED_SENDER)).toHaveLength(0);

    const second = await decision("telegram", DISMISSED_SENDER, "restore");
    expect(second).toEqual(first);
    expect(mappingRows("telegram", DISMISSED_SENDER)).toHaveLength(0);
  });

  it("refuses to dismiss an account a person holds, naming the owner", async () => {
    const res = await decide("whatsapp", LINKED_JID, "dismiss");
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as LinkConflict;
    expect(conflict.linkedPersonId).toBe(waPersonId);
    expect(conflict.linkedPersonName).toBe("Wanda Placed");
    expect(conflict.channel).toBe("whatsapp");
    expect(conflict.channelUserId).toBe(LINKED_JID);
    expect(conflict.error).toContain("Wanda Placed");

    // A refusal, not a half-write: the link is exactly as it was.
    const linked = find(await fetchPage(), `whatsapp:${LINKED_JID}`)!;
    expect(linked.state).toBe("linked");
    expect(linked.personId).toBe(waPersonId);
    expect(mappingRows("whatsapp", LINKED_JID)).toHaveLength(1);
  });

  it("refuses to restore an account a person holds, since restoring undoes a dismissal", async () => {
    const res = await decide("whatsapp", LINKED_JID, "restore");
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as LinkConflict;
    expect(conflict.linkedPersonId).toBe(waPersonId);

    const linked = find(await fetchPage(), `whatsapp:${LINKED_JID}`)!;
    expect(linked.state).toBe("linked");
    expect(linked.personId).toBe(waPersonId);
  });

  it("takes a dismissed account out of the unlinked listing and puts it under dismissed", async () => {
    const before = await fetchPage();
    expect(find(before, `whatsapp:${TALKING_JID}`)?.state).toBe("unlinked");

    await decision("whatsapp", TALKING_JID, "dismiss");

    const unlinked = await fetchPage("?state=unlinked");
    expect(find(unlinked, `whatsapp:${TALKING_JID}`)).toBeUndefined();
    expect(unlinked.accounts.every((account) => account.state === "unlinked")).toBe(true);

    const dismissed = await fetchPage("?state=dismissed");
    expect(dismissed.accounts.map(accountRef)).toContain(`whatsapp:${TALKING_JID}`);
    expect(dismissed.counts.dismissed).toBe(before.counts.dismissed + 1);
    expect(dismissed.counts.unlinked).toBe(before.counts.unlinked - 1);

    // And back again, by the other verb.
    await decision("whatsapp", TALKING_JID, "restore");
    const after = await fetchPage();
    expect(find(after, `whatsapp:${TALKING_JID}`)?.state).toBe("unlinked");
    expect(after.counts).toEqual(before.counts);
  });

  it("never puts the sentinel on the wire, in any answer either verb gives", async () => {
    const bodies = await Promise.all(
      [
        await decide("whatsapp", TALKING_JID, "dismiss"),
        await decide("whatsapp", TALKING_JID, "restore"),
        await decide("whatsapp", LINKED_JID, "dismiss"),
        await decide("telegram", DISMISSED_SENDER, "restore"),
      ].map((res) => res.text()),
    );
    for (const body of bodies) {
      expect(body).not.toContain(STRANGER_PERSON_ID);
      expect(body).not.toContain(STRANGER_PERSON_DISPLAY_NAME);
    }
  });

  it("loses the race rather than stealing a link placed after the read that cleared it", async () => {
    // The interleaving the refusal has to survive: the directory read that
    // decides the account answers before a rival's link lands, so the write
    // runs holding a presentation that says nobody has placed the account when
    // somebody just has. Checking before writing cannot see this; only the
    // write itself can refuse it.
    let rivalId: string | null = null;
    const repo = deps.personMappingRepo;
    const racing: AccountDecisionDeps = {
      ...deps,
      personMappingRepo: {
        findAllWithMappings: async () => {
          const stale = await repo.findAllWithMappings();
          rivalId ??= await repo.create({
            displayName: "Rival Claimant",
            bondLevel: "other",
            approved: true,
            channelMappings: [{ channel: "whatsapp", channelUserId: TALKING_JID }],
          });
          return stale;
        },
        linkAccount: repo.linkAccount.bind(repo),
        releaseStrangerClaims: repo.releaseStrangerClaims.bind(repo),
      },
    };

    const result = await dismissAccount(racing, {
      channel: "whatsapp",
      channelUserId: TALKING_JID,
    });

    // The rival won, and is named — the same refusal the guardian would have
    // been given had their page been one read newer.
    if (!("conflict" in result)) throw new Error("expected a conflict");
    expect(result.conflict.linkedPersonId).toBe(rivalId);
    expect(result.conflict.linkedPersonName).toBe("Rival Claimant");

    // And the placement is still theirs: a dismissal that displaced it would
    // have lost work the guardian did, silently.
    const rows = mappingRows("whatsapp", TALKING_JID);
    expect(rows).toHaveLength(1);
    expect(rows[0].personId).toBe(rivalId);
  });

  it("reads an address that had to be escaped to survive the path", async () => {
    // Channel identifiers are the platform's, not Rome's: LinkedIn URNs carry
    // colons, and a caller escapes whatever it was given. The account decided
    // has to be the one the escaping stood for.
    const urn = "urn:li:fsd_profile:ACoAAA+slash/and space";
    await deps.sentinelLogRepo.create({
      messageId: "msg-urn-1",
      channel: "linkedin",
      channelUserId: urn,
      displayName: "Escaped Sender",
      text: "hello from a punctuated id",
      action: "ignored",
    });

    const decided = await decision("linkedin", urn, "dismiss");
    expect(decided.channelUserId).toBe(urn);
    expect(decided.state).toBe("dismissed");
    expect(mappingRows("linkedin", urn)).toHaveLength(1);

    // And unescaped, which is what the identifier's wildcard segment is for: a
    // caller that did not escape a "/" is naming an account that exists, and a
    // plain segment would answer 404 for it.
    const raw = await app.request(`/accounts/linkedin/${urn}/restore`, { method: "POST" });
    expect(raw.status).toBe(200);
    expect(((await raw.json()) as DirectoryAccount).state).toBe("unlinked");
    expect(mappingRows("linkedin", urn)).toHaveLength(0);
  });

  it("answers 404 for a pair nothing has ever observed, rather than minting an account", async () => {
    const res = await decide("telegram", "never-seen-you", "dismiss");
    expect(res.status).toBe(404);
    expect(mappingRows("telegram", "never-seen-you")).toHaveLength(0);
  });

  it("decides the account, whichever of its addresses names it", async () => {
    // Named by the address the fold does not consider canonical: the decision
    // still lands on the one account, and reads back on its own address.
    const decided = await decision("whatsapp", LID_JID, "dismiss");
    expect(decided.channelUserId).toBe(PHONE_JID);
    expect(decided.state).toBe("dismissed");

    const page = await fetchPage("?includeSilent=true");
    const split = page.accounts.filter((account) => account.addresses.includes(LID_JID));
    expect(split).toHaveLength(1);
    expect(split[0].state).toBe("dismissed");

    // And the other address undoes it — one account, one decision, however the
    // caller addressed it.
    const restored = await decision("whatsapp", LID_JID, "restore");
    expect(restored.state).toBe("unlinked");
    expect(find(await fetchPage("?includeSilent=true"), `whatsapp:${PHONE_JID}`)?.state).toBe(
      "unlinked",
    );
    expect(mappingRows("whatsapp", PHONE_JID)).toHaveLength(0);
    expect(mappingRows("whatsapp", LID_JID)).toHaveLength(0);
  });
});
