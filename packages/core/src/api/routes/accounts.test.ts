import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { Hono } from "hono";
import {
  accountRef,
  type AccountDirectory,
  type AccountStream,
  type DirectoryAccount,
  type StreamAccount,
} from "@rome/api-types/people";
import { accountsRoutes } from "./accounts.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline } from "../../test/seeds.js";
import { STRANGER_PERSON_ID } from "../../constants.js";

// The two account reads over one set of sources — the links, the sentinel log
// and the channel mirrors. GET /accounts is the contacts list: every account
// Rome has observed, by name, carrying nothing about what anyone said. GET
// /accounts/stream is the recents surface: the accounts something has happened
// on, newest first, with the line to preview. These tests pin what each
// answers, what each filter narrows, and that the sentinel a dismissal is filed
// under never reaches a client.

const SILENT_JID = "15550001111@s.whatsapp.net";
const TALKING_JID = "15550002222@s.whatsapp.net";
const LINKED_JID = "15550003333@s.whatsapp.net";
const GROUP_JID = "120363000000000001@g.us";
const DISMISSED_SENDER = "tg-spammer";

describe("Accounts API", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let waPersonId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", accountsRoutes(deps));

    // The WhatsApp mirror: a silent address-book contact, a talking contact
    // nobody has placed, a contact linked to a person, and a group chat.
    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: SILENT_JID, phoneNumber: "15550001111", name: "Silent Sam" },
      { jid: TALKING_JID, phoneNumber: "15550002222", notify: "Talky Tina" },
      { jid: LINKED_JID, phoneNumber: "15550003333", name: "Alice WA" },
    ]);
    await deps.whatsAppStoreRepo.upsertChats([
      { jid: GROUP_JID, name: "Sunday hikes", isGroup: true },
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
    ]);

    waPersonId = await deps.personMappingRepo.create({
      displayName: "Wanda Placed",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "whatsapp", channelUserId: LINKED_JID }],
    });

    // A dismissal: the sender is filed under the stranger sentinel.
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

  async function fetchPage(query = ""): Promise<AccountDirectory> {
    const res = await app.request(`/accounts${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as AccountDirectory;
  }

  async function fetchStream(query = ""): Promise<AccountStream> {
    const res = await app.request(`/accounts/stream${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as AccountStream;
  }

  const find = <T extends DirectoryAccount>(page: { accounts: T[] }, ref: string): T | undefined =>
    page.accounts.find((account) => accountRef(account) === ref);

  it("lists an observed account nobody has placed, named by its platform", async () => {
    const tina = find(await fetchPage(), `whatsapp:${TALKING_JID}`)!;
    expect(tina.state).toBe("unlinked");
    expect(tina.personId).toBeNull();
    expect(tina.personName).toBeNull();
    expect(tina.displayName).toBe("Talky Tina");
  });

  it("says nothing about activity on a directory row", async () => {
    const page = await fetchPage();
    // Not merely unrendered: the contacts list carries no message-derived field
    // at all, so a client cannot start showing one and a read cannot start
    // computing one for it.
    for (const account of page.accounts) {
      expect(Object.keys(account).sort()).toEqual([
        "addresses",
        "channel",
        "channelUserId",
        "displayName",
        "personId",
        "personName",
        "state",
      ]);
    }
  });

  it("previews the newest thing on a stream row, and says nothing else about it", async () => {
    const stream = await fetchStream();
    const tina = find(stream, `whatsapp:${TALKING_JID}`)!;
    expect(tina.latest).toEqual({
      source: "whatsapp",
      timestamp: Math.floor(new Date("2026-08-17T10:00:00Z").getTime() / 1000),
      preview: "hello from tina",
    });
    // The preview is the whole of what a stream row says about a history. No
    // count rides beside it: none is read on this surface, so a client cannot
    // start rendering one.
    for (const account of stream.accounts) {
      expect(Object.keys(account).sort()).toEqual([
        "addresses",
        "channel",
        "channelUserId",
        "displayName",
        "latest",
        "personId",
        "personName",
        "state",
      ]);
    }
  });

  it("keeps an account nothing has happened on off the stream", async () => {
    const stream = await fetchStream();
    expect(find(stream, `whatsapp:${SILENT_JID}`)).toBeUndefined();
    // Including under a search: an account with no dynamic has no position in
    // an order made of timestamps, whatever was typed.
    expect((await fetchStream("?q=silent%20sam")).accounts).toEqual([]);
    // The contacts list is where that contact is looked up.
    expect(find(await fetchPage("?q=silent%20sam"), `whatsapp:${SILENT_JID}`)).toBeDefined();
  });

  it("names the person a linked account belongs to, and keeps the platform's own name", async () => {
    const linked = find(await fetchPage(), `whatsapp:${LINKED_JID}`)!;
    expect(linked.state).toBe("linked");
    expect(linked.personId).toBe(waPersonId);
    expect(linked.personName).toBe("Wanda Placed");
    // The account's name is the platform's. A guardian renaming the person does
    // not rename what WhatsApp calls the contact.
    expect(linked.displayName).toBe("Alice WA");
  });

  it("serializes a dismissal as a state, never as the sentinel it is filed under", async () => {
    const page = await fetchPage();
    const dismissed = find(page, `telegram:${DISMISSED_SENDER}`)!;
    expect(dismissed.state).toBe("dismissed");
    expect(dismissed.personId).toBeNull();
    expect(dismissed.personName).toBeNull();
    // Not merely absent from that row: the sentinel is not a person, so its id
    // may not reach a client on any row of any page.
    expect(JSON.stringify(page)).not.toContain(STRANGER_PERSON_ID);
  });

  it("filters the listing by state, and answers 400 for a state that is not one", async () => {
    const linked = await fetchPage("?state=linked");
    expect(linked.accounts.length).toBeGreaterThan(0);
    expect(linked.accounts.every((account) => account.state === "linked")).toBe(true);
    expect(find(linked, `whatsapp:${TALKING_JID}`)).toBeUndefined();

    const dismissed = await fetchPage("?state=dismissed");
    expect(dismissed.accounts.map(accountRef)).toEqual([`telegram:${DISMISSED_SENDER}`]);

    const unlinked = await fetchPage("?state=unlinked");
    expect(unlinked.accounts.every((account) => account.state === "unlinked")).toBe(true);

    const res = await app.request("/accounts?state=archived");
    expect(res.status).toBe(400);
    expect((await app.request("/accounts/stream?state=archived")).status).toBe(400);
  });

  it("counts every state over the whole directory, not over the page", async () => {
    const whole = await fetchPage();
    const narrowed = await fetchPage("?state=linked&limit=1");
    expect(narrowed.accounts).toHaveLength(1);
    // A client filtered to one chip still renders every chip's number.
    expect(narrowed.counts).toEqual(whole.counts);
    expect(whole.counts.linked).toBeGreaterThan(0);
    expect(whole.counts.dismissed).toBe(1);
    expect(whole.counts.unlinked).toBe(
      whole.accounts.filter((account) => account.state === "unlinked").length,
    );
  });

  it("carries a contact nobody has ever heard from, like a contacts app", async () => {
    const page = await fetchPage();
    const silent = find(page, `whatsapp:${SILENT_JID}`)!;
    expect(silent.displayName).toBe("Silent Sam");
    // The whole address book is the listing, so the unlinked count is everyone
    // Rome has not placed rather than the senders waiting on a decision. The
    // stream's counts answer that narrower question.
    expect(page.counts.unlinked).toBe(
      page.accounts.filter((account) => account.state === "unlinked").length,
    );
    expect((await fetchStream()).counts.unlinked).toBeLessThan(page.counts.unlinked);
  });

  it("lists an account on a channel with no history at all", async () => {
    const linkedSilent = await deps.personMappingRepo.create({
      displayName: "Quiet Link",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "signal", channelUserId: "sig-quiet" }],
    });
    const account = find(await fetchPage(), "signal:sig-quiet")!;
    expect(account.personId).toBe(linkedSilent);
  });

  it("finds an account by name, by number, and by the person holding it", async () => {
    const byName = await fetchPage("?q=silent%20sam");
    expect(byName.accounts.map(accountRef)).toEqual([`whatsapp:${SILENT_JID}`]);

    const byNumber = await fetchPage("?q=15550001111");
    expect(byNumber.accounts.map(accountRef)).toEqual([`whatsapp:${SILENT_JID}`]);

    // The person's name finds the accounts they were placed on.
    const byPerson = await fetchPage("?q=wanda");
    expect(byPerson.accounts.map(accountRef)).toEqual([`whatsapp:${LINKED_JID}`]);
  });

  it("excludes group chats — a group is not an account", async () => {
    const page = await fetchPage();
    expect(page.accounts.some((account) => account.channelUserId.includes(GROUP_JID))).toBe(false);
  });

  it("is one account for a contact the address book reaches two ways", async () => {
    const phoneJid = "15550009999@s.whatsapp.net";
    const lidJid = "99900099999@lid";
    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: phoneJid, name: "Split Contact" },
      { jid: lidJid, phoneNumber: "15550009999" },
    ]);
    // A sentinel row under the LID form, so the fold has to hold across sources.
    await deps.sentinelLogRepo.create({
      messageId: "msg-lid-1",
      channel: "whatsapp",
      channelUserId: lidJid,
      displayName: "Split Contact",
      text: "from the lid address",
      action: "ignored",
    });

    const page = await fetchPage();
    const split = page.accounts.filter((account) => account.addresses.includes(lidJid));
    expect(split).toHaveLength(1);
    expect(accountRef(split[0])).toBe(`whatsapp:${phoneJid}`);
    expect(split[0].addresses).toEqual([phoneJid, lidJid].sort());
    // And one row on the stream too, previewing what the other address said.
    const streamed = (await fetchStream()).accounts.filter((account) =>
      account.addresses.includes(lidJid),
    );
    expect(streamed).toHaveLength(1);
    expect(streamed[0].latest.preview).toBe("from the lid address");
  });

  it("pages by an opaque cursor that visits every account exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: AccountDirectory = await fetchPage(
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.accounts.length).toBeGreaterThan(0);
      seen.push(...page.accounts.map(accountRef));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null);

    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    const whole = await fetchPage("?limit=500");
    // The pages are the whole listing, in the listing's own order.
    expect(seen).toEqual(whole.accounts.map(accountRef));
  });

  it("rejects a cursor that names no position rather than answering the first page", async () => {
    expect((await app.request("/accounts?cursor=not-a-cursor")).status).toBe(400);
    expect((await app.request("/accounts/stream?cursor=not-a-cursor")).status).toBe(400);
    // The two orders are different orders: a position in one names none in the
    // other, and resuming with the wrong one would skip or repeat rows.
    const streamCursor = (await fetchStream("?limit=1")).nextCursor!;
    expect((await app.request(`/accounts?cursor=${encodeURIComponent(streamCursor)}`)).status).toBe(
      400,
    );
  });

  it("orders the directory by display name", async () => {
    const page = await fetchPage();
    const names = page.accounts.map((account) => account.displayName);
    expect(names).toEqual(
      [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    );
  });

  it("orders the stream by newest activity", async () => {
    const stream: AccountStream = await fetchStream();
    const timestamps = stream.accounts.map((account: StreamAccount) => account.latest.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });
});
