import { mkdtempSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { acquireChatGPTClipboardLock } from "./clipboard_lock.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("acquireChatGPTClipboardLock", () => {
  it("clears an expired stale lock before acquiring a new lease", async () => {
    const tempDir = createTempDir();
    const lockDir = join(tempDir, "chatgpt.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "lease.json"),
      JSON.stringify({
        ownerId: "stale-owner",
        createdAt: Date.now() - 5_000,
        expiresAt: Date.now() - 1_000,
        pid: 123,
      }),
      "utf8",
    );

    const lock = await acquireChatGPTClipboardLock({
      lockDir,
      leaseMs: 100,
      pollMs: 5,
    });

    const lease = JSON.parse(await readFile(join(lockDir, "lease.json"), "utf8")) as {
      ownerId: string;
    };
    expect(lease.ownerId).toBe(lock.ownerId);

    await lock.release();
    await expect(access(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("auto-releases the lock when the lease expires", async () => {
    const tempDir = createTempDir();
    const lockDir = join(tempDir, "chatgpt.lock");
    const firstLock = await acquireChatGPTClipboardLock({
      lockDir,
      leaseMs: 40,
      pollMs: 5,
    });

    const startedAt = Date.now();
    await sleep(60);
    const secondLock = await acquireChatGPTClipboardLock({
      lockDir,
      leaseMs: 40,
      pollMs: 5,
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);

    await secondLock.release();
    await firstLock.release();
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chatgpt-lock-"));
  tempDirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
