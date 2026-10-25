import { traceArchiveSessionKey } from "./trace-archive-paths.js";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { DrizzleDb } from "../db/index.js";
import { getSystemMigrationsPath } from "../db/migrate.js";
import { TraceArchivesRepository } from "../db/repositories/trace-archives.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { SessionQueryRepository } from "../db/repositories/session-query.js";
import { ARCHIVE_KEEP_BLOCK_TYPES } from "../db/schema.js";
import { getCoreRoot } from "../paths.js";
import { sessionTraceCutoff } from "./trace-retention.js";
import { runArchiveWorker, TraceArchiver, traceArchiveFile } from "./trace-archive.js";
import { TraceArchiveStorage } from "./trace-archive-storage.js";
import type { ArchiveFile, ArchiveWorkerInput } from "./trace-archive-worker.js";

const now = new Date("2026-10-25T12:00:00Z");
const old = Math.floor(now.getTime() / 1000) - 8 * 86400;
let dir: string;
let sqlite: Database.Database;
let db: DrizzleDb;
let repo: TraceArchivesRepository;
let webchat: WebChatRepository;
let root: string;
let server: Server | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rome-trace-archive-"));
  sqlite = new Database(join(dir, "rome.db"));
  sqlite.pragma("journal_mode = WAL");
  db = drizzle(sqlite);
  migrate(db, {
    migrationsFolder: getSystemMigrationsPath(),
    migrationsTable: "__drizzle_migrations_system",
  });
  repo = new TraceArchivesRepository(db);
  webchat = new WebChatRepository(db);
  root = join(dir, "archives/traces");
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});
function seed(
  id = "session",
  blocks: unknown[] = [
    { type: "tool_result", content: "heavy" },
    ...ARCHIVE_KEEP_BLOCK_TYPES.map((type) => ({ type })),
  ],
  at = old,
  parent: string | null = null,
) {
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO rome_sessions(id, name, type, parent_session_id, created_at, activity_at) VALUES (?, ?, 'webchat', ?, ?, ?)",
    )
    .run(id, id, parent, at, at);
  const messageId = `${id}-${at}`;
  sqlite
    .prepare(
      "INSERT INTO rome_agent_messages(id, session_id, turn_id, role, content, created_at) VALUES (?, ?, ?, 'trace', '[]', ?)",
    )
    .run(messageId, id, messageId, at);
  const insert = sqlite.prepare(
    "INSERT INTO rome_agent_trace_blocks(message_id, session_id, seq, content) VALUES (?, ?, ?, ?)",
  );
  sqlite.transaction(() => {
    blocks.forEach((block, seq) => insert.run(messageId, id, seq, JSON.stringify(block)));
  })();
  return messageId;
}
function archiver(extra: Partial<ConstructorParameters<typeof TraceArchiver>[0]> = {}) {
  return new TraceArchiver({
    repo,
    root,
    now: () => now,
    storage: new TraceArchiveStorage({ token: () => null }),
    ...extra,
  });
}
function archiveRows() {
  return sqlite.prepare("SELECT * FROM rome_trace_archives").all() as {
    id: string;
    status: string;
    location: string;
  }[];
}
function count() {
  return (
    sqlite.prepare("SELECT count(*) AS n FROM rome_agent_trace_blocks").get() as { n: number }
  ).n;
}
async function exportOnly(sessionId = "session", archiveId = "archive") {
  const data = await runArchiveWorker({
    action: "export",
    dbPath: sqlite.name,
    file: traceArchiveFile(root, sessionId, archiveId),
    sessionId,
    archiveId,
    createdAt: now.toISOString(),
  });
  if (!data) throw new Error("expected archive");
  repo.insert({
    id: archiveId,
    sessionId,
    status: "exported",
    location: `local:${sessionId}/${archiveId}.jsonl.gz`,
    bytes: data.bytes,
    sha256: data.sha256,
    manifest: JSON.stringify(data.manifest),
    blockCount: data.manifest.blockCount,
    messageCount: data.manifest.messageIds.length,
    createdAt: now,
  });
  return data;
}

describe("trace archives (real SQLite and worker)", () => {
  it("shares the step-1 ancestor rule, excludes marked turns, and orders oldest first", async () => {
    seed("root");
    seed("child", undefined, old - 86400, "root");
    seed("branch", undefined, old + 8 * 86400, "root");
    seed("oldest", undefined, old - 10 * 86400);
    seed("active-child", undefined, old, "branch");
    expect(repo.candidates(now).map((s) => s.sessionId)).toEqual(["oldest", "child", "root"]);
    expect(
      new Set(
        await webchat.getTraceArchivedSessionIds(
          ["oldest", "child", "root", "branch", "active-child"],
          sessionTraceCutoff(now),
        ),
      ),
    ).toEqual(new Set(["oldest", "child", "root"]));
    await archiver().runPass();
    expect(repo.candidates(now)).toEqual([]);
  });

  it("keeps Cloud keys under 128 characters without colliding with reserved or raw safe ids", () => {
    const long = "action:" + "x".repeat(95);
    const key = traceArchiveSessionKey(long);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toBe(traceArchiveSessionKey(long));
    expect(traceArchiveSessionKey(key)).not.toBe(key);
    expect(traceArchiveSessionKey("uuid-safe")).toBe("uuid-safe");
    expect(traceArchiveSessionKey("../escape")).not.toContain(".");
  });

  it("archives legacy action/channel ids with reversible Cloud-safe storage ids", async () => {
    const sessionId = "action:execution/agent";
    seed(sessionId);
    const { requests, storage } = await cloud();
    const stats = await archiver({ storage }).runPass();
    expect(stats.sessions).toBe(1);
    const key = JSON.parse(requests[0].body.toString()).sessionId as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(key.slice("encoded_b64_".length), "base64url").toString()).toBe(sessionId);
    expect(JSON.parse(gunzipSync(requests[1].body).toString().split("\n")[0]).sessionId).toBe(
      sessionId,
    );
    await webchat.deleteSession(sessionId);
    await archiver({ storage }).cleanupDeletedChats();
    expect(JSON.parse(requests[2].body.toString()).sessionId).toBe(key);
  });

  it("exports a self-describing byte-exact file, fsyncs/renames and keeps accounting blocks", async () => {
    const messageId = seed();
    const exact = '{ "type": "tool_result", "content": "中文 payload" }';
    sqlite
      .prepare("UPDATE rome_agent_trace_blocks SET content = ? WHERE message_id = ? AND seq = 0")
      .run(exact, messageId);
    const stats = await archiver({
      identity: () => ({ accountId: "account", instanceId: "instance" }),
    }).runPass();
    expect(stats).toMatchObject({ sessions: 1, rowsDeleted: 1, failures: 0 });
    const row = archiveRows()[0];
    expect(row.status).toBe("pruned");
    const file = traceArchiveFile(root, "session", row.id);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const lines = gunzipSync(readFileSync(file)).toString().trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({
      kind: "header",
      schemaVersion: 1,
      accountId: "account",
      instanceId: "instance",
      sessionId: "session",
      messageIds: [messageId],
      blockCount: 6,
      session: { name: "session", parentSessionId: null },
    });
    expect(lines[1]).toContain(`"block":${exact}`);
    expect(count()).toBe(5);
    const types = sqlite
      .prepare("SELECT json_extract(content, '$.type') AS type FROM rome_agent_trace_blocks")
      .all() as { type: string }[];
    expect(new Set(types.map((r) => r.type))).toEqual(new Set(ARCHIVE_KEEP_BLOCK_TYPES));
    await archiver().runPass();
    expect(archiveRows()).toHaveLength(1);
  });

  it("streams more data than the worker heap without blocking the main event loop", async () => {
    seed("large", []);
    const insert = sqlite.prepare(
      "INSERT INTO rome_agent_trace_blocks(message_id, session_id, seq, content) VALUES (?, 'large', ?, ?)",
    );
    const content = JSON.stringify({ type: "tool_result", content: "x".repeat(128 * 1024) });
    sqlite.transaction(() => {
      for (let i = 0; i < 512; i++) insert.run(`large-${old}`, i, content);
    })();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const file = traceArchiveFile(root, "large", "large-archive");
    try {
      const result = await new Promise<ArchiveFile>((resolve, reject) => {
        const worker = new Worker(join(getCoreRoot(), "src/webchat/trace-archive-worker.ts"), {
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 32 },
          workerData: {
            action: "export",
            file,
            dbPath: sqlite.name,
            sessionId: "large",
            archiveId: "large-archive",
            createdAt: now.toISOString(),
          },
        });
        worker.on("error", reject);
        worker.on("message", (m) => (m.error ? reject(new Error(m.error)) : resolve(m.result)));
      });
      expect(result.lines).toBe(513);
      expect(ticks).toBeGreaterThan(5);
      expect(result.sha256).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));
    } finally {
      clearInterval(timer);
    }
  }, 30_000);

  it("retains usage totals and Sessions-viewer model/status after prune", async () => {
    seed("session", [
      { type: "session_init", content: "heavy" },
      {
        type: "result",
        accounting: {
          provider: "openai",
          model: "test-model",
          usage: { inputTokens: 123, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1 },
          costUsd: 0.25,
        },
      },
      { type: "turn_end", status: "error", startedAt: old * 1000, completedAt: old * 1000 + 1000 },
      { type: "subagent_start", toolUseId: "child", sessionId: "child", turnId: "child-turn" },
      {
        type: "subagent_result",
        toolUseId: "child",
        sessionId: "child",
        turnId: "child-turn",
        status: "completed",
      },
    ]);
    sqlite
      .prepare(
        "UPDATE rome_agent_messages SET input_tokens = 123, output_tokens = 7, cost_usd = 0.25",
      )
      .run();
    const scope = { from: null, to: now };
    const query = new SessionQueryRepository(db);
    const before = await query.queryRunAggregates(scope);
    const usageBefore = await webchat.getUsageTotals({
      monthStart: new Date("2026-10-01T00:00:00Z"),
    });
    const subagentsBefore = sqlite
      .prepare(
        "SELECT content FROM rome_agent_trace_blocks WHERE json_extract(content, '$.type') LIKE 'subagent_%'",
      )
      .all();
    await archiver().runPass();
    expect(await query.queryRunAggregates(scope)).toEqual(before);
    expect(before[0]).toMatchObject({ modelName: "test-model", modelProvider: "openai" });
    expect(await webchat.getUsageTotals({ monthStart: new Date("2026-10-01T00:00:00Z") })).toEqual(
      usageBefore,
    );
    expect(
      sqlite
        .prepare(
          "SELECT content FROM rome_agent_trace_blocks WHERE json_extract(content, '$.type') LIKE 'subagent_%'",
        )
        .all(),
    ).toEqual(subagentsBefore);
  });

  it("reactivated sessions keep old turns archived across history, lazy, descendant and download repository reads", async () => {
    const oldId = seed();
    await archiver().runPass();
    const freshId = seed(
      "session",
      [{ type: "tool_result", content: "new full trace" }],
      Math.floor(now.getTime() / 1000),
    );
    const options = { sessionActivityCutoff: sessionTraceCutoff(now) };
    const history = await webchat.getTraceContents("session", options);
    expect(history.find((r) => r.id === oldId)).toMatchObject({
      content: "[]",
      traceArchived: true,
    });
    expect(history.find((r) => r.id === freshId)?.content).toContain("new full trace");
    expect(await webchat.getTraceContentByTurn("session", oldId, options)).toMatchObject({
      traceArchived: true,
    });
    expect(await webchat.getMessageContentForDisplay(oldId, options)).toMatchObject({
      traceArchived: true,
    });
    expect(
      await webchat.getTraceContentsByTurns([{ sessionId: "session", turnId: oldId }], options),
    ).toEqual([]);
    expect(
      (await webchat.getTraceAccountingByTurns([{ sessionId: "session", turnId: oldId }]))[0]
        .content,
    ).toContain('"type":"result"');
    expect(await webchat.getMessageContentForDisplay(oldId)).toMatchObject({ traceArchived: true });
  });

  it("reactivation between export and mark discards the archive and deletes no rows", async () => {
    seed();
    const data = await exportOnly();
    seed("session", [{ type: "tool_result", content: "new" }], Math.floor(now.getTime() / 1000));
    const stats = await archiver().runPass();
    expect(stats.rowsDeleted).toBe(0);
    expect(archiveRows()[0].status).toBe("discarded");
    expect(count()).toBe(7);
    expect(existsSync(traceArchiveFile(root, "session", data.manifest.archiveId))).toBe(false);
  });

  it("does not delete blocks appended to exported messages", async () => {
    const id = seed();
    await exportOnly();
    sqlite
      .prepare(
        "INSERT INTO rome_agent_trace_blocks(message_id, session_id, seq, content) VALUES (?, 'session', 6, ?)",
      )
      .run(id, JSON.stringify({ type: "tool_result", content: "post-export" }));
    // Prevent the same pass from immediately exporting a second snapshot.
    const stats = await archiver({ isRunning: () => true }).runPass();
    expect(stats.rowsDeleted).toBe(0);
    expect(count()).toBe(7);
    expect(archiveRows()[0].status).toBe("discarded");
  });

  it("resumes exported, stored-unmarked and stored-partially-pruned archives idempotently", async () => {
    for (const state of ["exported", "stored", "partial"] as const) {
      seed(state);
      const data = await exportOnly(state, `${state}-archive`);
      if (state !== "exported")
        repo.update(data.manifest.archiveId, { status: "stored", storedAt: now });
      if (state === "partial") {
        expect(repo.mark(data.manifest.archiveId, data.manifest, now)).toBe(true);
        repo.pruneBatch(data.manifest.archiveId);
        seed(
          state,
          [{ type: "tool_result", content: "reactivated" }],
          Math.floor(now.getTime() / 1000),
        );
      }
    }
    expect((await archiver().runPass()).failures).toBe(0);
    expect(archiveRows().every((r) => r.status === "pruned")).toBe(true);
    expect((await archiver().runPass()).rowsDeleted).toBe(0);
  });

  it("resumes confirmed Cloud storage without its removed local staging file", async () => {
    seed();
    const data = await exportOnly();
    repo.update("archive", { status: "stored", location: "s3:key", storedAt: now });
    await rm(traceArchiveFile(root, "session", "archive"));
    expect((await archiver().runPass()).rowsDeleted).toBe(1);
    expect(archiveRows()[0].status).toBe("pruned");
    expect(data.manifest.messageIds).toHaveLength(1);
  });

  it("stops new exports at 5 GiB of pending uploads", async () => {
    seed("backlog");
    await exportOnly("backlog");
    repo.update("archive", { bytes: 5 * 1024 ** 3 });
    seed("next");
    // Leave the pending export retryable, as an offline Cloud endpoint would.
    const worker = async (_input: ArchiveWorkerInput): Promise<ArchiveFile | null> => {
      throw new Error("offline");
    };
    const stats = await archiver({ worker }).runPass();
    expect(stats.bytesExported).toBe(0);
    expect(archiveRows()).toHaveLength(1);
    expect(count()).toBe(12);
  });

  it("message deletion and project deletion queue archive cleanup in their own transactions", async () => {
    seed("messages");
    seed("project");
    sqlite
      .prepare("UPDATE rome_sessions SET project_path = '/delete-project' WHERE id = 'project'")
      .run();
    await archiver().runPass();
    await webchat.deleteMessagesBySession("messages");
    expect(await webchat.deleteSessionsByProjectPathPrefix("/delete-project")).toBe(1);
    expect(new Set(repo.deletes())).toEqual(new Set(["messages", "project"]));
    await archiver().cleanupDeletedChats();
    expect(archiveRows()).toEqual([]);
    expect(repo.deletes()).toEqual([]);
  });

  it("discards an incomplete export with a missing file and can retry safely", async () => {
    seed();
    await exportOnly();
    await rm(traceArchiveFile(root, "session", "archive"));
    await archiver().runPass();
    expect(
      archiveRows()
        .map((r) => r.status)
        .sort(),
    ).toEqual(["discarded", "pruned"]);
  });

  it("caps deletes by bytes and rows, yields, and excludes post-snapshot seqs", async () => {
    const id = seed(
      "session",
      Array.from({ length: 30 }, () => ({ type: "tool_result", content: "x".repeat(1024 * 1024) })),
    );
    const data = await exportOnly();
    repo.update("archive", { status: "stored" });
    expect(repo.mark("archive", data.manifest, now)).toBe(true);
    sqlite
      .prepare(
        "INSERT INTO rome_agent_trace_blocks(message_id, session_id, seq, content) VALUES (?, 'session', 30, ?)",
      )
      .run(id, '{"type":"tool_result","content":"late"}');
    const batch = repo.pruneBatch("archive");
    expect(batch.rows).toBe(7);
    expect(batch.bytes).toBeLessThan(8 * 1024 * 1024);
    while (repo.pruneBatch("archive").rows) {}
    expect(count()).toBe(1);
  });
});

async function cloud(status = 200, error = "", putStatus = 200) {
  const requests: {
    method: string;
    path: string;
    body: Buffer;
    headers: import("node:http").IncomingHttpHeaders;
  }[] = [];
  let origin = "";
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method!, path: req.url!, body, headers: req.headers });
    if (req.method === "PUT") {
      res.writeHead(putStatus).end();
      return;
    }
    if (req.method === "DELETE") {
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(status === 200 ? { deleted: 1 } : { error }));
      return;
    }
    const parsed = JSON.parse(body.toString());
    res.writeHead(status, { "Content-Type": "application/json" }).end(
      JSON.stringify(
        status === 200
          ? {
              url: `${origin}/put`,
              method: "PUT",
              headers: {
                "Content-MD5": parsed.md5,
                "Content-Length": String(parsed.bytes),
                "Content-Type": "application/gzip",
              },
              objectKey: `key/${parsed.archiveId}`,
              expiresAt: now.toISOString(),
            }
          : { error },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    requests,
    succeed: () => {
      status = 200;
      putStatus = 200;
    },
    storage: new TraceArchiveStorage({ token: () => "test-instance-token", origin: () => origin }),
  };
}

describe("Pantheon + signed PUT contract", () => {
  it("uploads exact file bytes and headers, then removes the local file only after PUT 2xx", async () => {
    seed();
    const { requests, storage } = await cloud();
    const stats = await archiver({ storage }).runPass();
    expect(stats).toMatchObject({ sessions: 1, rowsDeleted: 1, failures: 0 });
    expect(stats.bytesUploaded).toBeGreaterThan(0);
    const post = requests[0];
    const put = requests[1];
    const body = JSON.parse(post.body.toString());
    expect(post.path).toBe("/api/instance/trace-archives/upload-url");
    expect(post.headers.authorization).toBe("Bearer test-instance-token");
    expect(put.headers.authorization).toBeUndefined();
    expect(put.headers["content-md5"]).toBe(body.md5);
    expect(put.body.length).toBe(body.bytes);
    expect(createHash("md5").update(put.body).digest("base64")).toBe(body.md5);
    expect(archiveRows()[0].location).toMatch(/^s3:/);
    expect(existsSync(traceArchiveFile(root, "session", archiveRows()[0].id))).toBe(false);
  });
  it("remembers not_hosted until restart and keeps local archives", async () => {
    seed();
    const { requests, storage } = await cloud(403, "not_hosted");
    const job = archiver({ storage });
    await job.runPass();
    seed("second");
    await job.runPass();
    expect(requests).toHaveLength(1);
    expect(
      archiveRows().every(
        (r) =>
          r.location.startsWith("local:") &&
          existsSync(
            traceArchiveFile(root, r.id === archiveRows()[0].id ? "session" : "second", r.id),
          ),
      ),
    ).toBe(true);
  });
  for (const failure of ["503", "PUT", "network"] as const) {
    it(`${failure} failure keeps the file and all rows, then resumes with a successful upload`, async () => {
      seed();
      const { storage, succeed } = await cloud(
        failure === "503" ? 503 : 200,
        "archive_storage_unconfigured",
        failure === "PUT" ? 500 : 200,
      );
      const failing =
        failure === "network"
          ? new TraceArchiveStorage({ token: () => "test", origin: () => "http://127.0.0.1:1" })
          : storage;
      expect((await archiver({ storage: failing }).runPass()).failures).toBe(1);
      expect(count()).toBe(6);
      expect(archiveRows()[0].status).toBe("exported");
      expect(existsSync(traceArchiveFile(root, "session", archiveRows()[0].id))).toBe(true);
      succeed();
      await archiver({ storage }).runPass();
      expect(archiveRows()[0].status).toBe("pruned");
    });
  }
  it("chat deletion removes local files and durably retries remote deletion without blocking the chat", async () => {
    seed();
    await archiver().runPass();
    const file = traceArchiveFile(root, "session", archiveRows()[0].id);
    await webchat.deleteSession("session");
    expect(repo.deletes()).toEqual(["session"]);
    const { requests, storage } = await cloud(503, "archive_storage_unconfigured");
    await archiver({ storage }).cleanupDeletedChats();
    expect(existsSync(file)).toBe(false);
    expect(repo.deletes()).toEqual(["session"]);
    expect(requests[0].method).toBe("DELETE");
    expect(JSON.parse(requests[0].body.toString())).toEqual({ sessionId: "session" });
    await archiver().cleanupDeletedChats();
    expect(repo.deletes()).toEqual([]);
  });
  it("reactivation discards the new upload without erasing earlier valid archives", async () => {
    seed();
    const { requests, storage } = await cloud();
    await archiver({ storage }).runPass();
    seed("session", [{ type: "tool_result", content: "second idle period" }], old + 1);
    const wrapped = {
      store: async (...args: Parameters<TraceArchiveStorage["store"]>) => {
        const result = await storage.store(...args);
        seed(
          "session",
          [{ type: "tool_result", content: "reactivated" }],
          Math.floor(now.getTime() / 1000),
        );
        return result;
      },
      deleteSession: storage.deleteSession.bind(storage),
    } as TraceArchiveStorage;
    const stats = await archiver({ storage: wrapped }).runPass();
    expect(stats.rowsDeleted).toBe(0);
    expect(
      archiveRows()
        .map((r) => r.status)
        .sort(),
    ).toEqual(["discarded", "pruned"]);
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    await webchat.deleteSession("session");
    await archiver({ storage }).cleanupDeletedChats();
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("a delete during a PUT cannot leave an object uploaded after the remote deletion", async () => {
    seed();
    const { requests, storage } = await cloud();
    const wrapped = {
      store: async (...args: Parameters<TraceArchiveStorage["store"]>) => {
        await webchat.deleteSession("session");
        return storage.store(...args);
      },
      deleteSession: storage.deleteSession.bind(storage),
    } as TraceArchiveStorage;
    await archiver({ storage: wrapped }).runPass();
    expect(requests.map((r) => r.method)).toEqual(["POST", "PUT", "DELETE"]);
    expect(repo.deletes()).toEqual([]);
    expect(archiveRows()).toEqual([]);
    expect(count()).toBe(0);
  });
});
