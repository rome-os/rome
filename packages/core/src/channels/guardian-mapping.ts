import type { Account } from "@rome-os/app-runtime";
import type { DrizzleTx } from "../db/index.js";
import type { PeopleRepository } from "../db/repositories/people.js";
import { createLogger } from "../logger.js";

const log = createLogger("guardian-mapping");

/**
 * Auto-map the guardian person onto their own account on a platform.
 *
 * Called on connect for channels that surface the guardian's self address
 * (WhatsApp pairing today) and by the channels routes/descriptors. Returns
 * `true` when a link was created or re-canonicalized, `false` when the
 * account was already linked or dismissed, or no guardian person exists.
 */
export async function mapGuardianToChannel(
  repo: PeopleRepository,
  platform: string,
  accountId: string,
): Promise<boolean> {
  const account: Account = { platform, id: accountId };
  const existing = await repo.byAccount(account);
  if (existing) {
    log.info("account already linked", { platform, accountId, personId: existing.id });
    return false;
  }
  if (await repo.isDismissed(account)) {
    log.info("account was dismissed, not linking", { platform, accountId });
    return false;
  }

  const guardians = await repo.byBondLevel("guardian");
  if (guardians.length === 0) {
    log.warn("no guardian person found, skipping auto-map", { platform });
    return false;
  }

  const guardian = guardians[0];

  const stale = staleAddress(guardian.links, platform);
  if (stale) {
    if (repo.readdress(guardian.id, { platform, id: stale }, accountId)) {
      log.info("re-canonicalized guardian link", {
        platform,
        from: stale,
        to: accountId,
        personId: guardian.id,
      });
      return true;
    }
    // Nothing holds the guardian read above against the write, so a link write
    // can retire that account in between. Fall through and map the incoming one
    // rather than report a heal that did not happen. The transactional path
    // cannot: its write is one statement settled before the transaction opened.
    log.info("guardian account to re-canonicalize is gone", {
      platform,
      from: stale,
      personId: guardian.id,
    });
  }

  await repo.linkStated(account, guardian.id);
  log.info("auto-mapped guardian to account", { platform, accountId, personId: guardian.id });
  return true;
}

/**
 * The address on `platform` that the incoming one supersedes, or undefined when
 * the incoming one is a further account rather than a canonicalization.
 *
 * A single held address is stale by definition here: the connect callback only
 * ever hands over the guardian's *current* self address, the caller has already
 * established that nobody holds it, and what remains is the same account under a
 * superseded identifier — e.g. a device-suffixed WhatsApp self JID
 * (`<pn>:8@s.whatsapp.net`) captured before canonicalization. Re-pointing it
 * keeps the mapping joinable to the canonicalized contacts mirror.
 *
 * Several held addresses are several accounts (a person may hold more than one
 * per platform, and the link verb places them), and nothing distinguishes a
 * superseded one from a live one. Adding the incoming address leaves a stale
 * identifier behind at worst; re-pointing an arbitrary one would take an account
 * away from the guardian.
 */
function staleAddress(links: readonly Account[], platform: string): string | undefined {
  const onPlatform = links.filter((link) => link.platform === platform);
  return onPlatform.length === 1 ? onPlatform[0].id : undefined;
}

/**
 * The decided guardian-mapping write, computed from async reads BEFORE a
 * transaction opens so the write itself can be a single synchronous statement
 * inside a caller-owned transaction (see {@link applyGuardianMappingWithinTx}).
 * `noop` covers "already mapped", "dismissed" and "no guardian person" — the same skip cases
 * {@link mapGuardianToChannel} returns `false` for.
 */
export type GuardianMappingPlan =
  | { op: "noop" }
  | { op: "add"; guardianId: string }
  | { op: "update"; guardianId: string; from: string };

/**
 * Read-only half of the guardian auto-map: decide whether (and how) to map the
 * account, without writing. Mirrors {@link mapGuardianToChannel}'s branching
 * so the transactional grant path (`ConnectionRegistry.giveGrant`) reaches the
 * same decision, then applies it inside the credential-write transaction. Safe to
 * run before the transaction: the terminal grant already holds the registry's
 * per-(connection kind, grant) section, so no competing grant can change the guardian
 * between plan and apply.
 *
 * An account another writer claimed in that window does not abort the grant,
 * on either branch: the add upserts and the re-point takes `to` from its holder,
 * so both commit. That settles the right way round here — the channel handed this
 * account over as the guardian's own, so a competing claim on it is the one
 * mistaken about whose it is. The grant aborting would cost the guardian the
 * credential in the same transaction, to preserve a claim that is wrong.
 */
export async function planGuardianMapping(
  repo: PeopleRepository,
  platform: string,
  accountId: string,
): Promise<GuardianMappingPlan> {
  const account: Account = { platform, id: accountId };
  if (await repo.byAccount(account)) return { op: "noop" };
  if (await repo.isDismissed(account)) return { op: "noop" };

  const guardians = await repo.byBondLevel("guardian");
  if (guardians.length === 0) return { op: "noop" };

  const guardian = guardians[0];
  const stale = staleAddress(guardian.links, platform);
  // The plan names the row it re-points, so an account placed between this read
  // and the apply — a link write runs outside the grant section that holds
  // competing grants off — is left where it is rather than swept onto
  // `accountId` with it.
  return stale
    ? { op: "update", guardianId: guardian.id, from: stale }
    : { op: "add", guardianId: guardian.id };
}

/**
 * Write half of the guardian auto-map: apply a {@link GuardianMappingPlan} as one
 * synchronous statement enlisted in the caller's transaction. A throw here aborts
 * the whole grant transaction (credential + placeholder + mapping), leaving
 * zero residual state.
 *
 * A planned re-point whose `from` is gone by now — a link write moved or
 * removed that account in the window — writes nothing and leaves the incoming
 * account unmapped, which the log below records. Deliberate: the guardian
 * decided where that account belongs more recently than the plan did, and
 * failing the grant over it would cost them the credential too. The next
 * connect maps the incoming account.
 */
export function applyGuardianMappingWithinTx(
  tx: DrizzleTx,
  repo: PeopleRepository,
  platform: string,
  accountId: string,
  plan: GuardianMappingPlan,
): void {
  if (plan.op === "noop") return;
  if (plan.op === "update") {
    const moved = repo.readdress(plan.guardianId, { platform, id: plan.from }, accountId, tx);
    if (!moved) {
      log.info("planned guardian re-point found no account to move", {
        platform,
        from: plan.from,
        to: accountId,
        personId: plan.guardianId,
      });
    }
  } else {
    repo.linkStated({ platform, id: accountId }, plan.guardianId, tx);
  }
}
