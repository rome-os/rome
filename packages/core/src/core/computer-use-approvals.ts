import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { JWT_SECRET } from "../access/auth.js";
import type { SettingsRepository } from "../db/repositories/settings.js";

const PREFIX = "computerUse.approval:";
const DEV_JWT_SECRET = "rome-dev-secret-change-me";

/**
 * Protected device approvals (both instance-local and paired remote Macs) require an
 * explicit ROME_JWT_SECRET of at least 32 characters that matches the effective JWT_SECRET.
 */
export function isProtectedApprovalSecret(
  configuredSecret: string | undefined = process.env.ROME_JWT_SECRET,
  effectiveSecret: string = JWT_SECRET,
): boolean {
  return Boolean(
    configuredSecret &&
      configuredSecret.length >= 32 &&
      effectiveSecret === configuredSecret &&
      effectiveSecret !== DEV_JWT_SECRET,
  );
}

export function isComputerUseApprovalSetting(key: string): boolean {
  return key.startsWith(PREFIX);
}

export type ComputerUseApprovalScope = "local" | "mac";

export function computerUseApprovalKey(
  actor: { userId: string; accountId?: string },
  deviceId: string,
  scope: ComputerUseApprovalScope,
): string {
  return PREFIX + JSON.stringify([actor.userId, actor.accountId ?? null, scope, deviceId]);
}

export async function readComputerUseApproval(
  settings: Pick<SettingsRepository, "get">,
  key: string,
): Promise<string | undefined> {
  const token = await settings.get(key);
  const parts = typeof token === "string" && /^([0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(token);
  if (!parts) return undefined;
  const [, id, proof] = parts;
  if (!timingSafeEqual(Buffer.from(proof, "hex"), approvalProof(key, id))) return undefined;
  return id;
}

export async function grantComputerUseApproval(
  settings: Pick<SettingsRepository, "get" | "set">,
  key: string,
): Promise<void> {
  if (await readComputerUseApproval(settings, key)) return;
  const id = randomUUID();
  await settings.set(key, `${id}.${approvalProof(key, id).toString("hex")}`);
}

// Older versions let the generic settings route write arbitrary keys.
function approvalProof(key: string, id: string): Buffer {
  return createHmac("sha256", JWT_SECRET)
    .update(JSON.stringify([key, id]))
    .digest();
}
