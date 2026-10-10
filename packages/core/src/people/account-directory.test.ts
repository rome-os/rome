// What the account reads ask the triage record for.
//
// The triage record is the only source that says an account exists on a channel
// Rome mirrors no address book for, so both reads enumerate its senders. Neither
// renders anything derived from what a sender said: the directory previews
// nothing at all, and the stream's preview comes from a `Messages` store
// (timeline-sources.ts), read in its own second pass. So these tests pin the
// question the reads ask — which senders exist — and that they ask no other.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { sentinelLog } from "../db/schema.js";
import { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../test/helpers.js";
import { seedBaseline } from "../test/seeds.js";
import {
  readAccountDirectory,
  readAccountStream,
  type AccountDirectoryDeps,
} from "./account-directory.js";

/** A Telegram sender the triage record is the only record of: no address book
 *  mirrors the channel, and no link names the address. */
const SENDER = "tg-sender";

describe("the account reads over the triage record", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  /** Which methods the reads called on the triage record, in call order. */
  let asked: string[];

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);

    // Two rows for the one sender, so a read that folds them wrong shows up as a
    // duplicate row rather than as the same answer either way.
    const first = await deps.sentinelLogRepo.create({
      messageId: "msg-tg-1",
      channel: "telegram",
      channelUserId: SENDER,
      displayName: "Sandy Sender",
      text: "first line",
      action: "ignored",
    });
    await deps.sentinelLogRepo.create({
      messageId: "msg-tg-2",
      channel: "telegram",
      channelUserId: SENDER,
      displayName: "Sandy Sender",
      text: "second line",
      action: "ignored",
    });
    // `create` files a row at the moment it runs, so both land in the same
    // second and neither is the newer. Backdating one puts them in an order, so
    // which line a preview shows is an answer rather than a tie.
    await testDb.db
      .update(sentinelLog)
      .set({ createdAt: new Date("2026-08-17T09:00:00Z") })
      .where(eq(sentinelLog.id, first));

    asked = [];
  });

  afterEach(() => testDb.close());

  /**
   * The deps with the triage record behind a double that answers the senders and
   * records what it was asked.
   *
   * Only the projection is on the double, so a read reaching past it fails
   * outright instead of being noticed after the fact by a caller that already
   * got its answer.
   */
  function watched(): AccountDirectoryDeps {
    const log = new SentinelLogRepository(testDb.db);
    return {
      ...deps,
      sentinelLogRepo: {
        listSenders: () => {
          asked.push("listSenders");
          return log.listSenders();
        },
      },
    };
  }

  const find = <T extends { channel: string; channelUserId: string }>(accounts: T[]) =>
    accounts.find((account) => account.channel === "telegram" && account.channelUserId === SENDER);

  it("enumerates the directory's senders through the projection alone", async () => {
    await readAccountDirectory(watched());
    expect(asked).toEqual(["listSenders"]);
  });

  it("enumerates the stream's senders through the projection alone", async () => {
    await readAccountStream(watched());
    expect(asked).toEqual(["listSenders"]);
  });

  it("lists a sender as one account, named by what it last called itself", async () => {
    const sandy = find(await readAccountDirectory(watched()))!;
    expect(sandy.addresses).toEqual([SENDER]);
    // The name is the triage record's, but read through `AccountNames`, which is
    // what answers for every channel — a mirror's name first, this second.
    expect(sandy.displayName).toBe("Sandy Sender");
    expect(sandy.state).toBe("unlinked");
  });

  it("previews the sender's newest line on the stream", async () => {
    // What a message store answers, not an aggregate the account read carried:
    // the two rows are one account, previewing the later of them.
    const sandy = find(await readAccountStream(watched()))!;
    expect(sandy.latest.preview).toBe("second line");
    expect(sandy.latest.source).toBe("telegram");
  });

  it("lists exactly the accounts it lists with the real repository", async () => {
    const ref = (account: { channel: string; channelUserId: string }) =>
      `${account.channel}:${account.channelUserId}`;
    const doubled = (await readAccountDirectory(watched())).map(ref).sort();
    expect(doubled).toEqual((await readAccountDirectory(deps)).map(ref).sort());
  });
});
