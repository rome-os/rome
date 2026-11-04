// The agent of each of Rome's connected accounts, named by its account or by
// the id of the connection that reaches it. `GET /api/connected-accounts` lists every
// connected account, disconnected ones included, and `GET /api/connections`
// lists each connection's account with its agent.
// Vocabulary: docs/domains/chats.md#connected-account.
// Invariants: docs/architecture/channels.md#an-accounts-agent.

import type {
  ConnectedAccountEntry,
  LinkAccountAgentRequest,
  LinkAccountAgentResult,
  LinkConnectedAccountResult,
  ListConnectedAccountsResult,
} from "@rome/api-types/connected-accounts";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  ConnectedAccountNotFound,
  type ConnectedAccountRow,
  ConnectedAccountsRepository,
} from "../../db/repositories/connected-accounts.js";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import {
  AccountNotLinkable,
  linkAccountAgent,
} from "../../chats/connected-accounts/account-agents.js";
import { accountLinkOf, connectionKindOf } from "../../chats/connected-accounts/account-links.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import type { ApiDeps } from "../deps.js";

const linkBodySchema: z.ZodType<LinkAccountAgentRequest> = z.object({
  agent: z.string().trim().min(1).nullable(),
});

function entryOf(row: ConnectedAccountRow): ConnectedAccountEntry {
  return {
    account: { platform: row.platform, id: row.accountId },
    name: row.name,
    agent: row.agent,
    connection: row.connectionId,
  };
}

export function connectedAccountsRoutes(
  deps: Pick<ApiDeps, "db" | "agentLoader" | "accountListening" | "connectionRegistry">,
): Hono {
  const app = new Hono();
  const linkOf = accountLinkOf(deps.connectionRegistry);
  const accounts = new ConnectedAccountsRepository(deps.db);
  const kindOf = connectionKindOf(deps.connectionRegistry);

  // The agent a link asks for, by its canonical id, or the refusal to answer.
  async function askedAgent(c: Context): Promise<{ agent: string | null } | Response> {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    const parsed = linkBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Name an agent, or null to unlink." }, 400);
    }
    const agent = parsed.data.agent;
    // The repository stores main by its canonical id, so main skips the loader.
    if (agent === null || isCoreMainAgentId(agent)) return { agent };
    if (!deps.agentLoader.has(agent)) {
      return c.json({ error: `Agent "${agent}" is not loaded.` }, 400);
    }
    return { agent: deps.agentLoader.getCanonicalName(agent) };
  }

  // Every connected account with its agent, and the connection that reaches
  // it, null for one that is disconnected.
  app.get("/connected-accounts", (c) => {
    const result: ListConnectedAccountsResult = { accounts: accounts.all().map(entryOf) };
    return c.json(result);
  });

  // Link, switch or unlink the agent of the account named by its platform and
  // the platform's own id. A connected one goes through the connection that
  // reaches it, by the same rules as below. A disconnected one keeps its agent
  // and can be unlinked, but takes a new agent only once it is connected
  // again, since its kind of connection decides whether it takes one.
  app.put("/connected-accounts/:platform/:accountId/agent", async (c) => {
    const asked = await askedAgent(c);
    if (asked instanceof Response) return asked;
    const key = { platform: c.req.param("platform"), accountId: c.req.param("accountId") };
    const missing = () => c.json({ error: "Rome has no connected account for that account." }, 404);
    const before = accounts.get(key);
    if (!before) return missing();
    try {
      if (before.connectionId !== null) {
        linkAccountAgent(kindOf, linkOf, accounts, before.connectionId, asked.agent);
        deps.accountListening.changed([before.connectionId]);
      } else if (asked.agent === null) {
        accounts.unlink(key);
      } else {
        return c.json(
          { error: "This account is not connected. Connect it again to link an agent." },
          409,
        );
      }
    } catch (err) {
      if (err instanceof ConnectedAccountNotFound) return missing();
      if (err instanceof AccountNotLinkable) return c.json({ error: err.message }, 400);
      throw err;
    }
    const after = accounts.get(key);
    if (!after) return missing();
    const result: LinkConnectedAccountResult = { account: entryOf(after) };
    return c.json(result);
  });

  // Link an agent to a connected account, or unlink it with `null`. Only this
  // account changes: the agent keeps every other account it is linked to.
  // Only an account whose kind of connection takes an agent takes a link;
  // unlinking is always open. Rome listens to such an account only while it
  // has an agent, so the account starts or stops listening.
  app.put("/accounts/:id/agent", async (c) => {
    const asked = await askedAgent(c);
    if (asked instanceof Response) return asked;
    const agent = asked.agent;
    const id = c.req.param("id");
    try {
      const linked = linkAccountAgent(kindOf, linkOf, accounts, id, agent);
      deps.accountListening.changed([id]);
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
