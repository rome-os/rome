// The account of an agent in the guardian's own Rome Cloud account is the
// guardian's, like any other account of theirs. Vocabulary:
// docs/domains/access.md.

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { settings } from "../../db/schema.js";
import { createLogger } from "../../logger.js";
import { giveGuardian, memberContextWithinTx } from "./members.js";

const log = createLogger("own-agent-account");

/** The settings key that records every agent this step gave the guardian. */
export const OWN_AGENTS_GIVEN_KEY = "agentsGuardianLinkedAgentIds";

/**
 * Gives the guardian the account on `platform` of an agent Rome Cloud says is
 * in the guardian's own Rome Cloud account, the first time it writes, before
 * anything reads who sent its message. An account that belongs to anyone
 * stays theirs, so the guardian's own decision stands. Rome records each agent
 * it gave the guardian and never gives it again, so an agent whose account the
 * guardian took away stays away, while a new agent with a removed one's name
 * is given anew. Nothing changes while Rome has no guardian. The record and the
 * account are written in one transaction, so a failure leaves both unchanged;
 * it is logged and never refuses the message.
 */
export function ownAgentAccount(db: DrizzleDb, platform: string): (agentId: string) => void {
  return (agentId) => {
    try {
      db.transaction((tx) => {
        const { identity, access } = memberContextWithinTx(tx);
        const account = { platform, accountId: agentId };
        if (identity.personOf(account)) return;
        const stored = tx
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, OWN_AGENTS_GIVEN_KEY))
          .get()?.value;
        const given = Array.isArray(stored) ? (stored as string[]) : [];
        if (given.includes(agentId)) return;
        const guardian = access.members().find((member) => member.role === "guardian");
        if (!guardian) return;
        const value = [...given, agentId];
        const updatedAt = new Date();
        tx.insert(settings)
          .values({ key: OWN_AGENTS_GIVEN_KEY, value, updatedAt })
          .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
          .run();
        giveGuardian(identity, guardian.personId, account);
        log.info("gave the guardian an agent in their own Rome Cloud account", { agentId });
      });
    } catch (err) {
      log.warn("could not give the guardian an agent of theirs", {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
