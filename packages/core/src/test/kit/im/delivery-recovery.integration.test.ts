import { execFile } from "node:child_process";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "@rstest/core";
import { ReplyDeliveryRepository } from "../../../db/repositories/reply-delivery.js";
import { replyDeliveryParts } from "../../../db/schema.js";
import { WechatApiFixture, WECHAT_USER } from "./wechat.js";

it("recovers a killed sender without replaying accepted or uncertain WeChat parts", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "rome-delivery-recovery-"));
  const databasePath = join(directory.path, "rome.sqlite");
  const sqlite = new Database(databasePath);
  try {
    migrate(drizzle(sqlite), {
      migrationsFolder: fileURLToPath(new URL("../../../../drizzle/system", import.meta.url)),
      migrationsTable: "__drizzle_migrations_system",
    });
  } finally {
    sqlite.close();
  }
  await writeFile(
    join(directory.path, "context_tokens.json"),
    JSON.stringify({ [WECHAT_USER]: "fixture-context" }),
  );
  const fixture = await new WechatApiFixture().start();
  const worker = join(directory.path, "sender.mts");
  const moduleUrl = (path: string) => new URL(`../../../${path}.ts`, import.meta.url).href;
  await writeFile(
    worker,
    `
import { createDb } from ${JSON.stringify(moduleUrl("db/index"))};
import { ReplyDeliveryRepository } from ${JSON.stringify(moduleUrl("db/repositories/reply-delivery"))};
import { WechatAdapter } from ${JSON.stringify(moduleUrl("channels/wechat"))};
import { RunDelivery } from ${JSON.stringify(moduleUrl("connections/delivery/run-delivery"))};
import { DeliveryScheduler } from ${JSON.stringify(moduleUrl("connections/delivery/scheduler"))};
import { plainTextCodec } from ${JSON.stringify(moduleUrl("connections/delivery/transport"))};
import { wechatDeliveryProfile } from ${JSON.stringify(moduleUrl("connections/integrations/delivery-profiles"))};
const [databasePath, statePath, origin, recipient] = process.argv.slice(2);
const repo = new ReplyDeliveryRepository(createDb({ type: "sqlite", sqlitePath: databasePath }));
const adapter = new WechatAdapter({ token: "fixture-token", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "fixture-bot", connectedAt: new Date(0).toISOString(), statePath },
  (input, init) => { const url = new URL(String(input)); return fetch(origin + url.pathname + url.search, init); });
await adapter.start();
const run = new RunDelivery("crashed", { conversationId: recipient }, {
  profile: { ...wechatDeliveryProfile("crash"), maxPartSize: 4, coalesceMs: 0, operationSpacingMs: 0, createSpacingMs: 0, conversationSpacingMs: 0 },
  codec: plainTextCodec, assertAuthorized() {},
  async create(target, text) { await adapter.createText(target.conversationId, text); return { conversationId: target.conversationId }; },
}, new DeliveryScheduler(), {
  async record(attempt) {
    if (attempt.partIx === 1 && attempt.outcome === "accepted") process.kill(process.pid, "SIGKILL");
    await repo.record(attempt);
  },
}, (error) => { throw error; });
await run.finish("abcdefgh");
throw new Error("Sender should have been killed");
`,
  );
  try {
    const require = createRequire(import.meta.url);
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          worker,
          databasePath,
          directory.path,
          fixture.server.url,
          WECHAT_USER,
        ],
        { timeout: 5000 },
      ),
    ).rejects.toMatchObject({ signal: "SIGKILL" });
    expect(fixture.messages).toHaveLength(2);
    const reopened = new Database(databasePath);
    try {
      const db = drizzle(reopened);
      const repository = new ReplyDeliveryRepository(db);
      expect((await db.select().from(replyDeliveryParts)).map((row) => row.outcome)).toEqual([
        "accepted",
        "attempting",
      ]);
      await repository.recoverInterrupted();
      await repository.recoverInterrupted();
      const rows = await db.select().from(replyDeliveryParts);
      expect(rows.map((row) => row.outcome)).toEqual(["accepted", "unknown"]);
      expect(rows[0].receipt).toMatchObject({ conversationId: WECHAT_USER });
      expect(rows[1].receipt).toBeNull();
      expect(
        fixture.server.calls.filter((call) => call.path.endsWith("/sendmessage")),
      ).toHaveLength(2);
      fixture.server.assertClean();
    } finally {
      reopened.close();
    }
  } finally {
    await fixture.close();
  }
});
