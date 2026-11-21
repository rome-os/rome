import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isRecord } from "../actions.js";
import { privateComputerUseDirectory } from "./native-bridge.js";
import { boundedString, ComputerUseError } from "./protocol.js";

const MAX_RECORD_BYTES = 8192;
const KEY = /^[0-9a-f]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CAUSE = /^[a-z0-9_]{1,100}$/;

type DispatchStatus = "not_dispatched" | "dispatched_unverified" | "unknown";
type VerificationStatus = "verified" | "not_verified" | "unverifiable";

export interface ComputerUseRecovery {
  sessionId: string;
  actionId: string;
  status: DispatchStatus;
  effectVerified: boolean;
  verificationStatus?: VerificationStatus;
  eventsPosted?: number;
  operationsDispatched?: number;
  terminalCause?: string;
  stopConfirmed?: true;
}

function conflict(): never {
  throw new ComputerUseError(
    "computer_ledger_conflict",
    "A computer-use ledger record is invalid.",
  );
}

function verifyReceipt(record: Record<string, unknown>): {
  status: VerificationStatus;
  effectVerified: boolean;
} {
  const { status, effectVerified } = record;
  if (
    (status !== "verified" && status !== "not_verified" && status !== "unverifiable") ||
    effectVerified !== (status === "verified")
  )
    return conflict();
  return { status, effectVerified };
}

function dispatchStatus(value: unknown): DispatchStatus {
  if (value !== undefined && (typeof value !== "string" || !CAUSE.test(value))) return conflict();
  return value === "not_dispatched" || value === "dispatched_unverified" ? value : "unknown";
}

function count(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return conflict();
  return value;
}

function actionIdentity(record: Record<string, unknown>): { sessionId: string; actionId: string } {
  const { sessionId, actionId } = record;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || !boundedString(actionId, 100))
    return conflict();
  return { sessionId, actionId };
}

function checkedVerification(
  record: Record<string, unknown>,
  identity: { sessionId: string; actionId: string },
): ReturnType<typeof verifyReceipt> {
  if (
    record.version !== 1 ||
    record.sessionId !== identity.sessionId ||
    record.actionId !== identity.actionId
  )
    return conflict();
  return verifyReceipt(record);
}

/** Atomic creation is the cross-process action-id gate. Existing intents are never replayed. */
export class ComputerUseLedger {
  private prepared: Promise<void> | undefined;
  constructor(private readonly directory: string) {}

  private prepare(): Promise<void> {
    return (this.prepared ??= privateComputerUseDirectory(this.directory));
  }

  private async create(path: string, record: unknown): Promise<boolean> {
    const encoded = JSON.stringify(record);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > MAX_RECORD_BYTES)
      return conflict();
    await this.prepare();
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(encoded);
      await file.sync();
      try {
        await link(temporary, join(this.directory, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      const directory = await open(this.directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return true;
    } finally {
      await file.close();
      await unlink(temporary).catch(() => {});
    }
  }

  private async read(name: string): Promise<Record<string, unknown> | undefined> {
    try {
      if (!isAbsolute(this.directory)) return conflict();
      const directory = await lstat(this.directory);
      if (
        !directory.isDirectory() ||
        directory.uid !== process.getuid?.() ||
        directory.mode & 0o077
      )
        return conflict();
      const file = await open(
        join(this.directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          info.mode & 0o077 ||
          info.size < 1 ||
          info.size > MAX_RECORD_BYTES
        )
          return conflict();
        const bytes = Buffer.alloc(info.size + 1);
        let read = 0;
        while (read < bytes.length) {
          const { bytesRead } = await file.read(bytes, read, bytes.length - read, read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        if (read !== info.size) return conflict();
        const data: unknown = JSON.parse(
          new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, read)),
        );
        if (
          !isRecord(data) ||
          typeof data.at !== "number" ||
          !Number.isSafeInteger(data.at) ||
          data.at < 0
        )
          return conflict();
        return data;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return conflict();
    }
  }

  private async readTerminal(sessionId: string): Promise<string | undefined> {
    const record = await this.read(`${sessionId}.terminal.json`);
    if (!record) return undefined;
    if (
      record.version !== 1 ||
      typeof record.terminalCause !== "string" ||
      !CAUSE.test(record.terminalCause)
    )
      return conflict();
    return record.terminalCause;
  }

  key(peer: string, actionId: string): string {
    if (!boundedString(peer) || !boundedString(actionId, 100)) return conflict();
    return createHash("sha256").update(peer).update("\0").update(actionId).digest("hex");
  }

  async intent(
    peer: string,
    sessionId: string,
    actionId: string,
    record: Record<string, unknown>,
  ): Promise<string> {
    const key = this.key(peer, actionId);
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return conflict();
    try {
      if (
        !(await this.create(`${key}.intent.json`, {
          ...record,
          version: 1,
          sessionId,
          actionId,
          at: Date.now(),
        }))
      )
        throw new ComputerUseError(
          "duplicate_action",
          "This action id already has a durable intent. Observe again and make a new decision; do not replay it.",
        );
      return key;
    } catch (error) {
      if (error instanceof ComputerUseError) throw error;
      throw new ComputerUseError(
        "computer_ledger_unavailable",
        "The computer-use intent could not be recorded, so no input was dispatched.",
      );
    }
  }

  async outcome(key: string, record: Record<string, unknown>): Promise<void> {
    if (typeof key !== "string" || !KEY.test(key)) return conflict();
    if (!(await this.create(`${key}.outcome.json`, { ...record, at: Date.now() })))
      throw new ComputerUseError(
        "computer_ledger_conflict",
        "An outcome for this action already exists.",
      );
  }

  /** Keeps the first independent verification separate from the dispatch outcome. */
  async verification(key: string, record: Record<string, unknown>): Promise<void> {
    if (typeof key !== "string" || !KEY.test(key)) return conflict();
    const receipt = verifyReceipt(record);
    const intent = await this.read(`${key}.intent.json`);
    if (!intent || intent.version !== 1) return conflict();
    const identity = actionIdentity(intent);
    const name = `${key}.verification.json`;
    if (!(await this.create(name, { version: 1, ...identity, ...receipt, at: Date.now() }))) {
      const prior = await this.read(name);
      if (!prior) return conflict();
      checkedVerification(prior, identity);
    }
  }

  async terminal(sessionId: string, cause: string): Promise<string> {
    if (
      typeof sessionId !== "string" ||
      !SESSION_ID.test(sessionId) ||
      typeof cause !== "string" ||
      !CAUSE.test(cause)
    )
      return conflict();
    const path = `${sessionId}.terminal.json`;
    if (
      await this.create(path, {
        version: 1,
        diagnosticId: randomUUID(),
        at: Date.now(),
        terminalCause: cause,
      })
    )
      return cause;
    return (await this.readTerminal(sessionId)) ?? conflict();
  }

  async confirmStop(sessionId: string, cause: string): Promise<string> {
    const terminalCause = await this.terminal(sessionId, cause);
    const name = `${sessionId}.stop-confirmed.json`;
    if (
      await this.create(name, {
        version: 1,
        sessionId,
        terminalCause,
        stopConfirmed: true,
        at: Date.now(),
      })
    )
      return terminalCause;
    const recorded = await this.read(name);
    if (!recorded || this.confirmedCause(recorded, sessionId) !== terminalCause) return conflict();
    return terminalCause;
  }

  private confirmedCause(record: Record<string, unknown>, sessionId: string): string {
    if (
      record.version !== 1 ||
      record.sessionId !== sessionId ||
      record.stopConfirmed !== true ||
      typeof record.terminalCause !== "string" ||
      !CAUSE.test(record.terminalCause)
    )
      return conflict();
    return record.terminalCause;
  }

  /** Reads receipts without restoring a session or granting authority to act. */
  async recover(peer: string, actionId: string): Promise<ComputerUseRecovery | undefined> {
    const key = this.key(peer, actionId);
    const intent = await this.read(`${key}.intent.json`);
    if (!intent) return undefined;
    const identity = actionIdentity(intent);
    if (intent.version !== 1 || identity.actionId !== actionId) return conflict();
    const { sessionId } = identity;
    const [outcome, verification, confirmed] = await Promise.all([
      this.read(`${key}.outcome.json`),
      this.read(`${key}.verification.json`),
      this.read(`${sessionId}.stop-confirmed.json`),
    ]);
    const status = dispatchStatus(outcome?.status);
    const recovered: ComputerUseRecovery = { ...identity, status, effectVerified: false };
    const eventsPosted = count(outcome?.eventsPosted);
    const operationsDispatched = count(outcome?.operationsDispatched);
    if (eventsPosted !== undefined) recovered.eventsPosted = eventsPosted;
    if (operationsDispatched !== undefined) recovered.operationsDispatched = operationsDispatched;
    if (verification) {
      const receipt = checkedVerification(verification, identity);
      if (status === "dispatched_unverified") {
        recovered.verificationStatus = receipt.status;
        recovered.effectVerified = receipt.effectVerified;
      }
    }
    const terminalCause = await this.readTerminal(sessionId);
    if (confirmed) {
      if (this.confirmedCause(confirmed, sessionId) !== terminalCause) return conflict();
      recovered.terminalCause = terminalCause;
      recovered.stopConfirmed = true;
    }
    return recovered;
  }
}
