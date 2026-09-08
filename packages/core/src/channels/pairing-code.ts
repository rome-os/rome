import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProfileDir } from "../paths.js";

export function loadPairingKey(): Buffer {
  const dir = getProfileDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "pairing.key");
  try {
    writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("Invalid pairing key");
  return key;
}

export function pairingCode(key: Buffer, approvalId: string): string {
  return `ROME-PAIR-${createHmac("sha256", key).update(approvalId).digest("hex").slice(0, 20).toUpperCase()}`;
}

export function matchesPairingCode(expected: string, submitted: string): boolean {
  const value = Buffer.from(submitted.trim().toUpperCase());
  const code = Buffer.from(expected);
  return value.length === code.length && timingSafeEqual(value, code);
}

export function isPairingCodeMessage(text: string | undefined): boolean {
  return /^ROME-PAIR-/i.test(text?.trim() ?? "");
}
