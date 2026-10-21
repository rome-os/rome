import type { DrizzleTx } from "../db/index.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { createLogger } from "../logger.js";

const log = createLogger("guardian-mapping");

/**
 * Auto-map the guardian person onto their own account on a channel.
 *
 * Called on connect for channels that surface the guardian's self address
 * (WhatsApp pairing today) and by the channels routes/descriptors. Returns
 * `true` when a mapping was created or re-canonicalized, `false` when the
 * channel user was already mapped or no guardian person exists.
 */
export async function mapGuardianToChannel(
  repo: PersonMappingRepository,
  channel: string,
  channelUserId: string,
): Promise<boolean> {
  const existing = await repo.findByChannelUser(channel, channelUserId);
  if (existing) {
    log.info("channel user already mapped", { channel, channelUserId, personId: existing.id });
    return false;
  }

  const guardians = await repo.findByBondLevel("guardian");
  if (guardians.length === 0) {
    log.warn("no guardian person found, skipping auto-map", { channel });
    return false;
  }

  const guardian = guardians[0];

  const stale = staleAddress(guardian.channelMappings, channel);
  if (stale) {
    if (await repo.updateChannelUserId(guardian.id, channel, stale, channelUserId)) {
      log.info("re-canonicalized guardian channel mapping", {
        channel,
        from: stale,
        to: channelUserId,
        personId: guardian.id,
      });
      return true;
    }
    // Nothing holds the guardian read above against the write, so a link write
    // can retire that account in between. Fall through and map the incoming one
    // rather than report a heal that did not happen. The transactional path
    // cannot: its write is one statement settled before the transaction opened.
    log.info("guardian account to re-canonicalize is gone", {
      channel,
      from: stale,
      personId: guardian.id,
    });
  }

  await repo.addChannelMapping(guardian.id, channel, channelUserId);
  log.info("auto-mapped guardian to channel", { channel, channelUserId, personId: guardian.id });
  return true;
}

/**
 * The address on `channel` that the incoming one supersedes, or undefined when
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
 * per channel, and the link verb places them), and nothing distinguishes a
 * superseded one from a live one. Adding the incoming address leaves a stale
 * identifier behind at worst; re-pointing an arbitrary one would take an account
 * away from the guardian.
 */
function staleAddress(
  mappings: readonly { channel: string; channelUserId: string }[],
  channel: string,
): string | undefined {
  const onChannel = mappings.filter((m) => m.channel === channel);
  return onChannel.length === 1 ? onChannel[0].channelUserId : undefined;
}

/**
 * The decided guardian-mapping write, computed from async reads BEFORE a
 * transaction opens so the write itself can be a single synchronous statement
 * inside a caller-owned transaction (see {@link applyGuardianMappingWithinTx}).
 * `noop` covers "already mapped" and "no guardian person" — the same skip cases
 * {@link mapGuardianToChannel} returns `false` for.
 */
export type GuardianMappingPlan =
  | { op: "noop" }
  | { op: "add"; guardianId: string }
  | { op: "update"; guardianId: string; from: string };

/**
 * Read-only half of the guardian auto-map: decide whether (and how) to map the
 * channel user, without writing. Mirrors {@link mapGuardianToChannel}'s branching
 * so the transactional conferral path (`ConnectionRegistry.confer`) reaches the
 * same decision, then applies it inside the credential-write transaction. Safe to
 * run before the transaction: the terminal conferral already holds the registry's
 * per-(connection kind, grant) section, so no competing conferral can change the guardian
 * between plan and apply.
 *
 * An account another writer claimed in that window does not abort the conferral,
 * on either branch: the add upserts and the re-point takes `to` from its holder,
 * so both commit. That settles the right way round here — the channel handed this
 * account over as the guardian's own, so a competing claim on it is the one
 * mistaken about whose it is. The conferral aborting would cost the guardian the
 * credential in the same transaction, to preserve a claim that is wrong.
 */
export async function planGuardianMapping(
  repo: PersonMappingRepository,
  channel: string,
  channelUserId: string,
): Promise<GuardianMappingPlan> {
  const existing = await repo.findByChannelUser(channel, channelUserId);
  if (existing) return { op: "noop" };

  const guardians = await repo.findByBondLevel("guardian");
  if (guardians.length === 0) return { op: "noop" };

  const guardian = guardians[0];
  const stale = staleAddress(guardian.channelMappings, channel);
  // The plan names the row it re-points, so an account placed between this read
  // and the apply — a link write runs outside the grant section that holds
  // competing conferrals off — is left where it is rather than swept onto
  // `channelUserId` with it.
  return stale
    ? { op: "update", guardianId: guardian.id, from: stale }
    : { op: "add", guardianId: guardian.id };
}

/**
 * Write half of the guardian auto-map: apply a {@link GuardianMappingPlan} as one
 * synchronous statement enlisted in the caller's transaction. A throw here aborts
 * the whole conferral transaction (credential + placeholder + mapping), leaving
 * zero residual state.
 *
 * A planned re-point whose `from` is gone by now — a link write moved or
 * removed that account in the window — writes nothing and leaves the incoming
 * account unmapped, which the log below records. Deliberate: the guardian
 * decided where that account belongs more recently than the plan did, and
 * failing the conferral over it would cost them the credential too. The next
 * connect maps the incoming account.
 */
export function applyGuardianMappingWithinTx(
  tx: DrizzleTx,
  repo: PersonMappingRepository,
  channel: string,
  channelUserId: string,
  plan: GuardianMappingPlan,
): void {
  if (plan.op === "noop") return;
  if (plan.op === "update") {
    const moved = repo.writeChannelUserId(tx, plan.guardianId, channel, plan.from, channelUserId);
    if (!moved) {
      log.info("planned guardian re-point found no account to move", {
        channel,
        from: plan.from,
        to: channelUserId,
        personId: plan.guardianId,
      });
    }
  } else {
    repo.writeChannelMapping(tx, plan.guardianId, channel, channelUserId);
  }
}
