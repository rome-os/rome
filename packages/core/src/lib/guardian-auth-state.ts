import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { guardianAuth, persons } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import { proveIdentity, type ProveIdentityResult } from "./instance-identity.js";
import { createLogger } from "../logger.js";

const log = createLogger("guardian-account");

// A cloud-bound seat authenticates through its Rome Cloud
// account, never a local password — but `guardianAuth.passwordHash` is NOT NULL.
// We store this sentinel instead of a hash: it is not a valid bcrypt digest, so
// `verifyPassword` can never match it, and the local login route rejects it
// outright. The local password column stays for the offline/self-hosted fallback
// seat, which is created with a real hash via `/onboard/create-account`.
export const CLOUD_GUARDIAN_PASSWORD_SENTINEL = "cloud-account:no-local-password";

// Create the single guardian seat for a cloud-bound instance. The identity comes
// from the Rome Cloud account the browser just authenticated as; the cloud
// onboarding path collects no local username/password. Also seeds the STRANGER
// person row, mirroring `/onboard/create-account` so both seat origins leave the
// same baseline person graph.
export async function createCloudGuardian(
  db: DrizzleDb,
  accountId: string,
  email?: string | null,
  avatarUrl?: string | null,
): Promise<void> {
  await db.insert(guardianAuth).values({
    id: uuidv4(),
    userId: accountId,
    passwordHash: CLOUD_GUARDIAN_PASSWORD_SENTINEL,
    accountId,
    email: email ?? null,
    avatarUrl: avatarUrl ?? null,
    createdAt: new Date(),
  });
}

export interface GuardianAuthState {
  exists: boolean;
  onboardingComplete: boolean;
  userId: string | null;
  // Rome Cloud account this seat is bound to, or null for a
  // local-fallback seat / an instance whose account hasn't been resolved yet.
  // Later phases read this to compare a request's instance account against the
  // recorded owner.
  accountId: string | null;
  // Whether the seat has a usable local password (a real bcrypt hash, not the
  // cloud-only sentinel). Drives whether the cloud sign-in screen offers the
  // local-password fallback at all — a pure cloud seat reports false.
  hasLocalPassword: boolean;
}

export async function getGuardianAuthState(db: DrizzleDb): Promise<GuardianAuthState> {
  const [guardian] = await db
    .select({
      id: guardianAuth.id,
      userId: guardianAuth.userId,
      onboardingComplete: guardianAuth.onboardingComplete,
      accountId: guardianAuth.accountId,
      passwordHash: guardianAuth.passwordHash,
    })
    .from(guardianAuth)
    .limit(1);

  if (!guardian) {
    return {
      exists: false,
      onboardingComplete: false,
      userId: null,
      accountId: null,
      hasLocalPassword: false,
    };
  }

  return {
    exists: true,
    onboardingComplete: guardian.onboardingComplete ?? false,
    userId: guardian.userId,
    accountId: guardian.accountId ?? null,
    hasLocalPassword: guardian.passwordHash !== CLOUD_GUARDIAN_PASSWORD_SENTINEL,
  };
}

// Explicit cloud-login binding. Unlike `recordResolvedAccount`
// (observe-only, first-resolution-wins), this stamps the account a guardian
// *just authenticated as* through the cloud-login round trip, so it overwrites
// any prior value. Single-tenant: the one guardian row is updated unconditionally
// (mirrors the where-less update `/onboard/complete` uses). A no-op when no
// guardian row exists yet — the session is still issued, and the row is stamped
// once onboarding creates it (via the `/api/bootstrap` resolve path).
// `email` (the id_token claim, when present) rides along for display/audit.
// An absent claim keeps a previously recorded email only while the binding
// stays on the same account — a rebind must never carry the old account's
// email onto the new one (audit actors would name the wrong person), so it
// is replaced by the new claim or cleared.
export async function setGuardianAccount(
  db: DrizzleDb,
  accountId: string,
  email?: string | null,
  avatarUrl?: string | null,
): Promise<void> {
  const [guardian] = await db
    .select({ accountId: guardianAuth.accountId })
    .from(guardianAuth)
    .limit(1);
  const sameAccount = guardian?.accountId === accountId;
  await db.update(guardianAuth).set({
    accountId,
    ...(email ? { email } : sameAccount ? {} : { email: null }),
    ...(avatarUrl !== undefined ? { avatarUrl } : sameAccount ? {} : { avatarUrl: null }),
  });
}

export interface ResolveAndRecordOptions {
  /** Inject proveIdentity (tests). Defaults to the real Rome Cloud call. */
  prove?: typeof proveIdentity;
}

// Learn the cloud account that owns this instance and stamp
// it onto the guardian seat. Observe-only: it records a first binding and logs
// a mismatch, but never overwrites, never rejects. Run on guardian session
// activity (boot, /api/bootstrap).
export async function resolveAndRecordAccount(
  db: DrizzleDb,
  opts: ResolveAndRecordOptions = {},
): Promise<void> {
  let result: ProveIdentityResult;
  try {
    result = await (opts.prove ?? proveIdentity)();
  } catch (err) {
    log.warn("account resolve failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  await recordResolvedAccount(db, result);
}

// Apply an already-resolved identity to the guardian row. Split from the prove
// so the boot path can record from the single identity check it already runs
// for operator logging instead of proving Rome Cloud twice.
//
//  - First resolution wins: a null `accountId` is filled in from the bound
//    account and the accompanying profile fields are cached locally.
//  - A matching resolution refreshes profile fields without changing ownership.
//  - A *different* resolved account is logged as a would-reject mismatch and
//    left unrecorded — enforcement and any overwrite policy come in phase 3.
//  - A non-ok prove (unreachable/unknown/no_token/unconfigured/revoked) and a
//    missing guardian row are silent no-ops; `unreachable` is transient.
export async function recordResolvedAccount(
  db: DrizzleDb,
  result: ProveIdentityResult,
): Promise<void> {
  if (result.status !== "ok") return;
  const resolvedAccountId = result.identity.accountId;

  try {
    const [guardian] = await db
      .select({ id: guardianAuth.id, accountId: guardianAuth.accountId })
      .from(guardianAuth)
      .limit(1);
    if (!guardian) return;

    const profile = {
      ...(result.identity.email !== undefined ? { email: result.identity.email } : {}),
      ...(result.identity.avatarUrl !== undefined ? { avatarUrl: result.identity.avatarUrl } : {}),
    };

    if (guardian.accountId === null) {
      await db
        .update(guardianAuth)
        .set({ accountId: resolvedAccountId, ...profile })
        .where(eq(guardianAuth.id, guardian.id));
      log.info("recorded bound account", { accountId: resolvedAccountId });
      return;
    }

    if (guardian.accountId !== resolvedAccountId) {
      log.warn("account mismatch (would reject)", {
        recorded: guardian.accountId,
        resolved: resolvedAccountId,
      });
      return;
    }

    if (Object.keys(profile).length > 0) {
      await db.update(guardianAuth).set(profile).where(eq(guardianAuth.id, guardian.id));
    }
  } catch (err) {
    log.warn("account record failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
