import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { sql } from "drizzle-orm";
import type Database from "better-sqlite3";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { sqlMessages } from "./messages-sql.js";

// The batch looks a message's detail up after ranking, for the rows a call
// returns and no others: a directory's `count` and `latest` pass over whole
// histories, and describing every message they rank would cost a lookup each.

const ACCOUNT = [{ channel: "whatsapp", addresses: ["a"] }];
const OTHER = [{ channel: "whatsapp", addresses: ["b"] }];

describe("sqlMessages detail", () => {
  let testDb: TestDb;
  let looked: string[];

  beforeEach(() => {
    testDb = createTestDb();
    looked = [];
    // A probe standing in for a store's detail lookup, counting every row it
    // is evaluated for.
    const client = (testDb.db as unknown as { $client: Database.Database }).$client;
    client.function("detail_probe", (key: unknown) => {
      looked.push(String(key));
      return JSON.stringify({ key });
    });
  });

  afterEach(() => testDb.close());

  function store() {
    return sqlMessages({
      channel: "whatsapp",
      db: testDb.db,
      view: () => sql`
        SELECT 'whatsapp' AS source, column1 AS key, column2 AS at, 0 AS outbound,
               column3 AS ref, column3 AS body, column3 AS detail_key
        FROM (VALUES ('a', 1, 'r1'), ('a', 2, 'r2'), ('a', 3, 'r3'), ('a', 4, 'r4'),
                     ('b', 5, 'r5'))`,
      detail: {
        of: (key) => sql`detail_probe(${key})`,
        map: (raw) => ({ conversation: { id: String(raw.key), name: null, kind: null } }),
      },
    });
  }

  it("describes only the rows a read returns", async () => {
    const page = await store().read({ accounts: ACCOUNT, limit: 2 });
    expect(page.map((entry) => entry.conversation?.id)).toEqual(["r4", "r3"]);
    expect(looked.sort()).toEqual(["r3", "r4"]);
  });

  it("describes nothing for a count, and one row for a latest", async () => {
    const messages = store();
    const [total, otherTotal, newest] = await Promise.all([
      messages.count(ACCOUNT),
      messages.count(OTHER),
      messages.latest(ACCOUNT),
    ]);
    expect([total, otherTotal]).toEqual([4, 1]);
    expect(newest?.conversation?.id).toBe("r4");
    expect(looked).toEqual(["r4"]);
  });
});
