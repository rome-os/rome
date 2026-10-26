import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parentPort, workerData } from "node:worker_threads";
import { createGunzip, createGzip } from "node:zlib";
import Database from "better-sqlite3";
import type { ArchiveManifest } from "../db/repositories/trace-archives.js";

export interface ArchiveFile {
  manifest: ArchiveManifest;
  sha256: string;
  md5: string;
  bytes: number;
  lines: number;
}
export type ArchiveWorkerInput =
  | {
      file: string;
      action: "verify";
    }
  | {
      file: string;
      action: "export";
      dbPath: string;
      sessionId: string;
      archiveId: string;
      createdAt: string;
      identity?: { accountId: string; instanceId: string };
    };

async function verify(file: string): Promise<ArchiveFile> {
  const sha = createHash("sha256");
  const md5 = createHash("md5");
  let bytes = 0;
  let lines = 0;
  let header = "";
  const decoder = new StringDecoder("utf8");
  let manifest: ArchiveManifest | undefined;
  await pipeline(
    createReadStream(file),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sha.update(chunk);
        md5.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    }),
    createGunzip(),
    async (chunks) => {
      for await (const chunk of chunks) {
        const data = chunk as Buffer;
        for (const byte of data) if (byte === 10) lines++;
        if (!manifest) {
          const end = data.indexOf(10);
          header += decoder.write(data.subarray(0, end < 0 ? data.length : end));
          if (end >= 0) manifest = JSON.parse(header) as ArchiveManifest;
        }
      }
    },
  );
  if (
    !manifest ||
    manifest.kind !== "header" ||
    manifest.schemaVersion !== 1 ||
    lines !== manifest.blockCount + 1
  ) {
    throw new Error("Invalid trace archive manifest or line count");
  }
  return { manifest, sha256: sha.digest("hex"), md5: md5.digest("base64"), bytes, lines };
}

const validLegacyArraySql =
  "CASE WHEN json_valid(m.content) THEN json_type(m.content) = 'array' ELSE 0 END";
const legacyArraySql = `CASE WHEN ${validLegacyArraySql} THEN m.content ELSE '[]' END`;

async function exportFile(
  input: Extract<ArchiveWorkerInput, { action: "export" }>,
): Promise<ArchiveFile | null> {
  await mkdir(dirname(input.file), { recursive: true, mode: 0o700 });
  const db = new Database(input.dbPath, { readonly: true, fileMustExist: true });
  const tmp = `${input.file}.tmp`;
  try {
    // Hold one read snapshot through metadata and block iteration. WAL writers remain independent.
    db.exec("BEGIN");
    const session = db.prepare("SELECT * FROM rome_sessions WHERE id = ?").get(input.sessionId) as
      | Record<string, unknown>
      | undefined;
    if (!session) return null;
    const messages = db
      .prepare(`SELECT m.id, coalesce(max(b.seq), -1) AS maxSeq, count(b.seq) AS blockCount,
      CASE WHEN count(b.seq) = 0 THEN json_array_length(${legacyArraySql}) ELSE 0 END AS legacyCount
      FROM rome_agent_messages m LEFT JOIN rome_agent_trace_blocks b ON b.message_id = m.id
      WHERE m.session_id = ? AND m.role = 'trace' AND m.trace_archive_id IS NULL GROUP BY m.id HAVING count(b.seq) > 0 OR ${validLegacyArraySql}`)
      .all(input.sessionId) as {
      id: string;
      maxSeq: number;
      blockCount: number;
      legacyCount: number;
    }[];
    if (!messages.length) return null;
    const raw = db
      .prepare(`SELECT coalesce(sum(length(cast(b.content AS blob))), 0) AS bytes
      FROM rome_agent_messages m JOIN rome_agent_trace_blocks b ON b.message_id = m.id
      WHERE m.session_id = ? AND m.role = 'trace' AND m.trace_archive_id IS NULL`)
      .get(input.sessionId) as { bytes: number };
    const legacyBytes = db
      .prepare(`SELECT coalesce(sum(length(cast(m.content AS blob))), 0) AS bytes FROM rome_agent_messages m
      WHERE m.session_id = ? AND m.role = 'trace' AND m.trace_archive_id IS NULL AND NOT EXISTS
      (SELECT 1 FROM rome_agent_trace_blocks b WHERE b.message_id = m.id) AND ${validLegacyArraySql}`)
      .get(input.sessionId) as { bytes: number };
    const disk = await statfs(dirname(input.file));
    if (disk.bavail * disk.bsize < 2 * (raw.bytes + legacyBytes.bytes))
      throw new Error("Trace archive low disk");
    const last = db
      .prepare("SELECT max(created_at) AS at FROM rome_agent_messages WHERE session_id = ?")
      .get(input.sessionId) as { at: number | null };
    const manifest: ArchiveManifest = {
      kind: "header",
      schemaVersion: 1,
      accountId: input.identity?.accountId,
      instanceId: input.identity?.instanceId,
      sessionId: input.sessionId,
      archiveId: input.archiveId,
      createdAt: input.createdAt,
      session: {
        name: session.name,
        projectName: session.project_name,
        projectPath: session.project_path,
        agentName: session.agent_name,
        type: session.type,
        parentSessionId: session.parent_session_id,
        createdAt: new Date(Number(session.created_at) * 1000).toISOString(),
        lastActivityAt: last.at === null ? null : new Date(last.at * 1000).toISOString(),
      },
      messageIds: messages.map((m) => m.id),
      messages,
      blockCount: messages.reduce((n, m) => n + m.blockCount + (m.legacyCount ?? 0), 0),
    };
    const blocks =
      db.prepare(`SELECT b.message_id AS messageId, m.turn_id AS turnId, b.seq, b.content
      FROM rome_agent_messages m JOIN rome_agent_trace_blocks b ON b.message_id = m.id
      WHERE m.session_id = ? AND m.role = 'trace' AND m.trace_archive_id IS NULL ORDER BY m.id, b.seq`);
    const legacy =
      db.prepare(`SELECT m.id AS messageId, m.turn_id AS turnId, j.key AS seq, j.value AS content
      FROM rome_agent_messages m, json_each(${legacyArraySql}) j
      WHERE m.session_id = ? AND m.role = 'trace' AND m.trace_archive_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM rome_agent_trace_blocks b WHERE b.message_id = m.id)
      ORDER BY m.id, j.key`);
    function* jsonl() {
      yield `${JSON.stringify(manifest)}\n`;
      for (const statement of [blocks, legacy]) {
        for (const row of statement.iterate(input.sessionId) as Iterable<{
          messageId: string;
          turnId: string | null;
          seq: number;
          content: string;
        }>) {
          // Keep stored block JSON byte-exact and never collect a turn or session's blocks.
          yield `{"messageId":${JSON.stringify(row.messageId)},"turnId":${JSON.stringify(row.turnId)},"seq":${row.seq},"block":${row.content}}\n`;
        }
      }
    }
    const sha = createHash("sha256");
    const md5 = createHash("md5");
    let bytes = 0;
    await pipeline(
      Readable.from(jsonl()),
      createGzip({ level: 6 }),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sha.update(chunk);
          md5.update(chunk);
          bytes += chunk.length;
          callback(null, chunk);
        },
      }),
      createWriteStream(tmp, { mode: 0o600 }),
    );
    const handle = await open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, input.file);
    const directory = await open(dirname(input.file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const result = await verify(input.file);
    if (
      result.sha256 !== sha.digest("hex") ||
      result.md5 !== md5.digest("base64") ||
      result.bytes !== bytes
    ) {
      throw new Error("Trace archive read-back mismatch");
    }
    return result;
  } finally {
    db.close();
    await rm(tmp, { force: true });
  }
}

async function respond(input: ArchiveWorkerInput) {
  try {
    parentPort!.postMessage({
      result: input.action === "verify" ? await verify(input.file) : await exportFile(input),
    });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
}
if (parentPort) {
  if (workerData?.persistent) parentPort.on("message", respond);
  else await respond(workerData as ArchiveWorkerInput);
}
