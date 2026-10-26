// The agent of each of Rome's connected accounts, named by its connection's
// id. `GET /api/connections` lists each account with its agent.
// Vocabulary: docs/domains/chats.md#connected-account.
// Invariants: docs/architecture/channels.md#an-accounts-agent.

import type {
  LinkAccountAgentRequest,
  LinkAccountAgentResult,
} from "@rome/api-types/connected-accounts";
import { Hono } from "hono";
import { z } from "zod";
import { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";
import {
  ConnectedAccountNotFound,
  ConnectedAccountsRepository,
} from "../../db/repositories/connected-accounts.js";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { AccountNotLinkable, linkAccountAgent } from "../../channels/account-agents.js";
import { accountLinkOf } from "../../channels/account-links.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import type { ApiDeps } from "../deps.js";

const linkBodySchema: z.ZodType<LinkAccountAgentRequest> = z.object({
  agent: z.string().trim().min(1).nullable(),
});

export function connectedAccountsRoutes(
  deps: Pick<ApiDeps, "db" | "agentLoader" | "accountListening" | "connectionRegistry">,
): Hono {
  const app = new Hono();
  const linkOf = accountLinkOf(deps.connectionRegistry);
  const channels = new ChannelRecordsRepository(deps.db, linkOf);
  const accounts = new ConnectedAccountsRepository(deps.db);
  const kindOf = (connectionId: string): string | null =>
    deps.connectionRegistry?.all().find((conn) => conn.id === connectionId)?.connectionKind ?? null;

  // Link an agent to a connected account, or unlink it with `null`. Only this
  // account changes: the agent keeps every other account it is linked to.
  // Only an account whose kind of connection takes an agent takes a link;
  // unlinking is always open. Rome listens to such an account only while it
  // has an agent, so the account starts or stops listening.
  app.put("/accounts/:id/agent", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    const parsed = linkBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Name an agent, or null to unlink." }, 400);
    }
    let agent = parsed.data.agent;
    // The repository stores main by its canonical id, so main skips the loader.
    if (agent !== null && !isCoreMainAgentId(agent)) {
      if (!deps.agentLoader.has(agent)) {
        return c.json({ error: `Agent "${agent}" is not loaded.` }, 400);
      }
      agent = deps.agentLoader.getCanonicalName(agent);
    }
    const id = c.req.param("id");
    try {
      const linked = linkAccountAgent(kindOf, linkOf, accounts, id, agent);
      // Inbound ports listen by channel until the connection id replaces it.
      deps.accountListening.changed([channels.idOf(id)]);
      const result: LinkAccountAgentResult = {
        account: { id, agent: linked.agent, link: linked.link },
      };
      return c.json(result);
    } catch (err) {
      if (err instanceof ConnectedAccountNotFound) return c.json({ error: err.message }, 404);
      if (err instanceof AccountNotLinkable) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  return app;
}
