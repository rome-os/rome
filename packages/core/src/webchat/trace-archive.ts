import { traceArchiveRelativePath } from "./trace-archive-paths.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { setImmediate } from "node:timers/promises";
import type {
  ArchiveManifest,
  TraceArchive,
  TraceArchivesRepository,
} from "../db/repositories/trace-archives.js";
import { getCoreRoot, getProfileDir } from "../paths.js";
import { createLogger } from "../logger.js";
import type { ArchiveFile, ArchiveWorkerInput } from "./trace-archive-worker.js";
import { TraceArchiveStorage } from "./trace-archive-storage.js";

const log = createLogger("trace-archive");
function failureReason(error: unknown): string {
  return error instanceof Error && error.message.startsWith("Trace archive ")
    ? error.message
    : error instanceof Error
      ? error.name
      : "unknown";
}
const PENDING_LIMIT = 5 * 1024 ** 3;

export function traceArchiveFile(root: string, sessionId: string, archiveId: string): string {
  return join(root, traceArchiveRelativePath(sessionId, archiveId));
}

class ArchiveWorkerClient {
  private worker?: Worker;
  async run(input: ArchiveWorkerInput): Promise<ArchiveFile | null> {
    if (!this.worker) {
      const core = getCoreRoot();
      const source = join(core, "src/webchat/trace-archive-worker.ts");
      const entry =
        process.env.ROME_DOCKER_APP_CODE_MODE !== "compiled" && existsSync(source)
          ? source
          : join(core, "dist/webchat/trace-archive-worker.js");
      // Node 24 strips this worker's TS types. Do not inherit tsx/rstest loaders or debug flags.
      this.worker = new Worker(entry, { workerData: { persistent: true }, execArgv: [] });
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const onMessage = (message: { result?: ArchiveFile | null; error?: string }) => {
        cleanup();
        if (message.error) reject(new Error(message.error));
        else resolve(message.result ?? null);
      };
      const onError = (error: Error) => {
        cleanup();
        this.worker = undefined;
        reject(error);
      };
      const onExit = (code: number) => onError(new Error(`Trace export worker exited (${code})`));
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      worker.once("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      worker.postMessage(input);
    });
  }
  async close() {
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
  }
}

export async function runArchiveWorker(input: ArchiveWorkerInput): Promise<ArchiveFile | null> {
  const worker = new ArchiveWorkerClient();
  try {
    return await worker.run(input);
  } finally {
    await worker.close();
  }
}

export interface ArchivePassStats {
  sessions: number;
  bytesExported: number;
  bytesUploaded: number;
  bytesDeleted: number;
  rowsDeleted: number;
  maxBatchMs: number;
  failures: number;
}

export class TraceArchiver {
  private readonly root: string;
  private readonly storage: TraceArchiveStorage;
  private serial: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private exporter = new ArchiveWorkerClient();
  constructor(
    private readonly options: {
      repo: TraceArchivesRepository;
      root?: string;
      storage?: TraceArchiveStorage;
      identity?: () => { accountId: string; instanceId: string } | undefined;
      isRunning?: (sessionId: string) => boolean;
      now?: () => Date;
      worker?: typeof runArchiveWorker;
      onPass?: (stats: ArchivePassStats & { at: string; pendingBytes: number }) => Promise<void>;
    },
  ) {
    this.root = options.root ?? join(getProfileDir(), "archives/traces");
    this.storage = options.storage ?? new TraceArchiveStorage();
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    // Upload and chat cleanup share this queue. A delete can never overtake an in-flight PUT.
    const next = this.serial.then(run);
    this.serial = next.catch(() => {});
    return next;
  }
  stop() {
    this.stopped = true;
    return this.serial;
  }
  cleanupDeletedChats(): Promise<void> {
    return this.enqueue(async () => {
      await this.cleanup();
    });
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private worker(input: ArchiveWorkerInput) {
    return (this.options.worker ?? this.exporter.run.bind(this.exporter))(input);
  }
  private file(row: TraceArchive) {
    return traceArchiveFile(this.root, row.sessionId, row.id);
  }

  private async cleanup() {
    const repo = this.options.repo;
    let failures = 0;
    for (const sessionId of repo.deletes()) {
      try {
        // Validate ids before recursive removal. Archives only occupy this dedicated directory.
        const file = traceArchiveFile(this.root, sessionId, "cleanup");
        await rm(dirname(file), { recursive: true, force: true });
        const remoteRequired = repo.hasRemoteArchives(sessionId);
        await this.storage.deleteSession(sessionId, remoteRequired);
        repo.finishDelete(sessionId);
      } catch (error) {
        failures++;
        log.warn("chat archive deletion will retry", { sessionId, reason: failureReason(error) });
      }
    }
    return failures;
  }

  private async discard(row: TraceArchive) {
    await rm(this.file(row), { force: true });
    await rm(`${this.file(row)}.tmp`, { force: true });
    if (row.location.startsWith("s3:")) {
      // The fixed Cloud API deletes a whole session prefix, not one object. Never erase valid archives.
      if (this.options.repo.hasRetainedArchives(row.sessionId)) return;
      await this.storage.deleteSession(row.sessionId, true);
    }
    this.options.repo.update(row.id, {
      location: `local:${traceArchiveRelativePath(row.sessionId, row.id)}`,
    });
  }

  private async resume(row: TraceArchive, stats: ArchivePassStats, exported?: ArchiveFile) {
    const repo = this.options.repo;
    if (row.status === "discarded") {
      await this.discard(row);
      return;
    }
    let manifest: ArchiveManifest;
    if (row.status === "exported") {
      const file = this.file(row);
      if (!existsSync(file)) {
        repo.update(row.id, { status: "discarded" });
        await this.discard({ ...row, status: "discarded" });
        return;
      }
      const data = exported ?? (await this.worker({ action: "verify", file }));
      if (
        !data ||
        data.manifest.archiveId !== row.id ||
        data.manifest.sessionId !== row.sessionId ||
        (row.sha256 && row.sha256 !== data.sha256)
      )
        throw new Error("Archive verification failed");
      manifest = data.manifest;
      repo.update(row.id, {
        bytes: data.bytes,
        sha256: data.sha256,
        blockCount: manifest.blockCount,
        messageCount: manifest.messageIds.length,
        manifest: JSON.stringify(manifest),
      });
      const location = await this.storage.store(
        file,
        data,
        (target) => {
          // A lost PUT response is ambiguous. Keep enough state to retry privacy deletion even without a token.
          repo.update(row.id, { location: target });
        },
        row.location.startsWith("s3:"),
      );
      // A deletion during the PUT must not be undone by the store completion.
      if (repo.get(row.id)?.status === "discarded") {
        repo.update(row.id, {
          location: location ?? `local:${traceArchiveRelativePath(row.sessionId, row.id)}`,
        });
        return;
      }
      repo.update(row.id, {
        status: "stored",
        storedAt: this.now(),
        location: location ?? `local:${traceArchiveRelativePath(row.sessionId, row.id)}`,
      });
      if (location) {
        stats.bytesUploaded += data.bytes;
        await rm(file, { force: true });
      }
    } else {
      if (!row.manifest) throw new Error("Stored archive missing manifest");
      manifest = JSON.parse(row.manifest) as ArchiveManifest;
    }
    if (!repo.mark(row.id, manifest, this.now(), this.options.isRunning?.(row.sessionId))) {
      const current = repo.get(row.id);
      if (current?.status === "discarded") await this.discard(current);
      return;
    }
    while (!this.stopped) {
      const batch = repo.pruneBatch(row.id);
      stats.bytesDeleted += batch.bytes;
      stats.rowsDeleted += batch.rows;
      stats.maxBatchMs = Math.max(stats.maxBatchMs, batch.durationMs);
      if (!batch.rows) {
        // Also handles a crash between storing the location and unlinking the staging file.
        if (repo.get(row.id)?.location.startsWith("s3:")) await rm(this.file(row), { force: true });
        repo.update(row.id, { status: "pruned", prunedAt: this.now() });
        stats.sessions++;
        return;
      }
      await setImmediate();
    }
  }

  runPass(): Promise<ArchivePassStats> {
    return this.enqueue(async () => {
      try {
        const stats: ArchivePassStats = {
          sessions: 0,
          bytesExported: 0,
          bytesUploaded: 0,
          bytesDeleted: 0,
          rowsDeleted: 0,
          maxBatchMs: 0,
          failures: 0,
        };
        const started = performance.now();
        const repo = this.options.repo;
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        stats.failures += await this.cleanup();
        const failedSessions = new Set<string>();
        for (const row of repo.listPending()) {
          if (this.stopped) break;
          try {
            await this.resume(row, stats);
          } catch (error) {
            stats.failures++;
            failedSessions.add(row.sessionId);
            log.warn("trace archive resume will retry", {
              archiveId: row.id,
              reason: failureReason(error),
            });
          }
        }
        for (const candidate of repo.candidates(this.now())) {
          if (this.stopped || repo.pendingBytes() >= PENDING_LIMIT) break;
          if (
            failedSessions.has(candidate.sessionId) ||
            this.options.isRunning?.(candidate.sessionId)
          )
            continue;
          const id = randomUUID();
          const createdAt = this.now();
          const file = traceArchiveFile(this.root, candidate.sessionId, id);
          repo.insert({
            id,
            sessionId: candidate.sessionId,
            status: "exported",
            location: `local:${traceArchiveRelativePath(candidate.sessionId, id)}`,
            bytes: 0,
            sha256: "",
            blockCount: 0,
            messageCount: 0,
            createdAt,
          });
          try {
            const data = await this.worker({
              action: "export",
              file,
              dbPath: repo.sqlite.name,
              sessionId: candidate.sessionId,
              archiveId: id,
              createdAt: createdAt.toISOString(),
              identity: this.options.identity?.(),
            });
            if (!data) {
              repo.update(id, { status: "discarded" });
              await this.discard(repo.get(id)!);
              continue;
            }
            stats.bytesExported += data.bytes;
            repo.update(id, {
              bytes: data.bytes,
              sha256: data.sha256,
              blockCount: data.manifest.blockCount,
              messageCount: data.manifest.messageIds.length,
              manifest: JSON.stringify(data.manifest),
            });
            const row = repo.get(id)!;
            await this.resume(row, stats, data);
          } catch (error) {
            stats.failures++;
            log.warn("trace archive will retry", { archiveId: id, reason: failureReason(error) });
          }
          await setImmediate();
        }
        stats.failures += await this.cleanup();
        log.info("trace archive pass completed", {
          ...stats,
          durationMs: performance.now() - started,
          pendingBytes: repo.pendingBytes(),
        });
        await this.options.onPass?.({
          ...stats,
          at: this.now().toISOString(),
          pendingBytes: repo.pendingBytes(),
        });
        return stats;
      } finally {
        await this.exporter.close();
      }
    });
  }
}
