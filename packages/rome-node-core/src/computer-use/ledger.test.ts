import { afterEach, describe, expect, it } from "@rstest/core";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseLedger } from "./ledger.js";

const owner = "owner";
const actionId = "action-1";
const sessionId = "session-1";
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "rome-cua-ledger-"));
  folders.push(folder);
  const directory = join(folder, "ledger");
  return { directory, ledger: new ComputerUseLedger(directory) };
}

describe.skipIf(process.platform === "win32")("durable computer-use recovery", () => {
  it("returns no record for a missing or different owner's intent", async () => {
    const { directory, ledger } = await fixture();
    expect(await ledger.recover(owner, actionId)).toBeUndefined();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    const key = await ledger.intent(owner, sessionId, actionId, { operation: "press" });
    await ledger.outcome(key, { status: "not_dispatched", effectVerified: false });
    const restarted = new ComputerUseLedger(directory);
    expect(await restarted.recover("different-owner", actionId)).toBeUndefined();
    expect(await restarted.recover(owner, "different-action")).toBeUndefined();
    expect(await restarted.recover(owner, actionId)).toEqual({
      sessionId,
      actionId,
      status: "not_dispatched",
      effectVerified: false,
    });
    await expect(restarted.intent(owner, "new-session", actionId, {})).rejects.toMatchObject({
      code: "duplicate_action",
    });
  });

  it("preserves an ambiguous outcome and keeps a terminal cause separate from confirmed stop", async () => {
    const { directory, ledger } = await fixture();
    const key = await ledger.intent(owner, sessionId, actionId, { operation: "press" });
    await ledger.terminal(sessionId, "connection_lost");
    const restarted = new ComputerUseLedger(directory);
    const unknown = { sessionId, actionId, status: "unknown", effectVerified: false };
    expect(await restarted.recover(owner, actionId)).toEqual(unknown);
    await ledger.outcome(key, { status: "unknown", effectVerified: false });
    await ledger.verification(key, { status: "verified", effectVerified: true });
    expect(await restarted.recover(owner, actionId)).toEqual(unknown);
    expect(await ledger.confirmStop(sessionId, "cancelled")).toBe("connection_lost");
    expect(await restarted.recover(owner, actionId)).toEqual({
      ...unknown,
      terminalCause: "connection_lost",
      stopConfirmed: true,
    });
  });

  it("recovers the first dispatch, machine verification, and confirmed terminal cause across writers", async () => {
    const { directory, ledger } = await fixture();
    const key = await ledger.intent(owner, sessionId, actionId, { operation: "setValue" });
    const other = new ComputerUseLedger(directory);
    const value = "private test observation";
    const [, , stopped, terminal] = await Promise.all([
      ledger.outcome(key, {
        status: "dispatched_unverified",
        effectVerified: false,
        eventsPosted: 0,
        operationsDispatched: 1,
      }),
      other.verification(key, { status: "verified", effectVerified: true, axValue: value }),
      ledger.confirmStop(sessionId, "completed"),
      other.terminal(sessionId, "takeover"),
    ]);
    expect(stopped).toBe(terminal);
    await other.verification(key, { status: "not_verified", effectVerified: false });
    await expect(other.outcome(key, { status: "unknown" })).rejects.toMatchObject({
      code: "computer_ledger_conflict",
    });
    const files = await readdir(directory);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(await readFile(join(directory, file), "utf8")).not.toContain(value);
    expect(await new ComputerUseLedger(directory).recover(owner, actionId)).toEqual({
      sessionId,
      actionId,
      status: "dispatched_unverified",
      verificationStatus: "verified",
      effectVerified: true,
      eventsPosted: 0,
      operationsDispatched: 1,
      terminalCause: terminal,
      stopConfirmed: true,
    });
  });

  it("refuses unsafe paths, mismatched record identities and corrupt or oversized files", async () => {
    const { directory, ledger } = await fixture();
    const invalid = { code: "computer_ledger_conflict" };
    await expect(ledger.terminal("../not-a-session", "cancelled")).rejects.toMatchObject(invalid);
    await expect(ledger.outcome("../not-an-action", {})).rejects.toMatchObject(invalid);
    const key = await ledger.intent(owner, sessionId, actionId, {});
    const name = join(directory, `${key}.verification.json`);
    await writeFile(
      name,
      JSON.stringify({
        version: 1,
        sessionId: "different-session",
        actionId,
        status: "verified",
        effectVerified: true,
        at: 1,
      }),
      { mode: 0o600 },
    );
    await expect(ledger.recover(owner, actionId)).rejects.toMatchObject(invalid);
    await writeFile(name, "x".repeat(8193));
    await expect(ledger.recover(owner, actionId)).rejects.toMatchObject(invalid);
    await writeFile(name, "{invalid");
    await expect(ledger.recover(owner, actionId)).rejects.toMatchObject(invalid);
    await chmod(directory, 0o755);
    await expect(ledger.recover(owner, actionId)).rejects.toMatchObject(invalid);
  });

  it("does not follow a link at a receipt path", async () => {
    const { directory, ledger } = await fixture();
    const key = await ledger.intent(owner, sessionId, actionId, {});
    const otherFile = join(directory, "unrelated.json");
    await writeFile(otherFile, JSON.stringify({ status: "dispatched_unverified", at: 1 }), {
      mode: 0o600,
    });
    await symlink(otherFile, join(directory, `${key}.outcome.json`));
    await expect(ledger.recover(owner, actionId)).rejects.toMatchObject({
      code: "computer_ledger_conflict",
    });
  });
});
