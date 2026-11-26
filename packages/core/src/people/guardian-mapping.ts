import type { Account } from "@rome-os/app-runtime";
import type { PeopleRepository } from "./model/people-repository.js";
import { createLogger } from "../logger.js";

const log = createLogger("guardian-mapping");

/**
 * Link the guardian to their own account on a platform.
 *
 * Called by the email kind for the address it is told is the guardian's. Returns
 * `true` when a link was created or re-canonicalized, `false` when the
 * account was already linked or dismissed, or no guardian person exists.
 * With `addOnly`, the account is one more of the guardian's, as each Discord
 * account the guardian binds to Rome's Discord bot is: it is added beside the
 * guardian's other accounts on the platform, and none of them is re-pointed.
 */
export async function linkGuardianToAccount(
  repo: PeopleRepository,
  platform: string,
  accountId: string,
  opts: { addOnly?: boolean } = {},
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

  const stale = opts.addOnly ? undefined : staleAddress(guardian.links, platform);
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
    // rather than report a heal that did not happen.
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
