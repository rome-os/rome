// Accounts and their agents. An account is a channel, as the dashboard
// shows it; one whose Connection was deleted is listed with no Connection.
// Its agent is its connected account's.
// Vocabulary: docs/domains/chats.md#connected-account.
// Invariants: docs/architecture/channels.md#an-accounts-agent.

import type { AccountLink } from "@rome/api-types/account-agents";
import type {
  ChannelAccount,
  LinkAccountAgentRequest,
  LinkAccountAgentResult,
} from "@rome/api-types/channel-accounts";
import { Hono } from "hono";
import { z } from "zod";
import {
  ChannelNotLinkable,
  ChannelRecordNotFound,
  ChannelRecordsRepository,
  ChannelUnbacked,
  type ChannelRecord,
} from "../../db/repositories/channel-records.js";
import { ConnectedAccountsRepository } from "../../db/repositories/connected-accounts.js";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { linkChannelAgent } from "../../channels/account-agents.js";
import { accountLinkOf } from "../../channels/account-links.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import type { ApiDeps } from "../deps.js";

const linkBodySchema: z.ZodType<LinkAccountAgentRequest> = z.object({
  agent: z.string().trim().min(1).nullable(),
});

function accountView(
  record: ChannelRecord,
  agent: string | null,
  link: AccountLink | null,
): ChannelAccount {
  return {
    id: record.id,
    connectionKind: record.connectionKind,
    service: record.connectionKind,
    platform: record.platform,
    connectionId: record.connectionId,
    agent,
    link,
  };
}

export function channelAccountsRoutes(
  deps: Pick<ApiDeps, "db" | "agentLoader" | "accountListening" | "connectionRegistry">,
): Hono {
  const app = new Hono();
  const channels = new ChannelRecordsRepository(deps.db, accountLinkOf(deps.connectionRegistry));
  const accounts = new ConnectedAccountsRepository(deps.db);

  app.get("/channels/accounts", (c) => {
    c.header("Cache-Control", "no-store");
    const views = channels
      .all()
      .map((record) =>
        accountView(
          record,
          record.connectionId === null ? null : accounts.agentOf(record.connectionId),
          channels.linkOf(record.connectionKind),
        ),
      );
    return c.json({ accounts: views });
  });

  // Link an agent to an account, or unlink it with `null`. Only this account
  // changes: the agent keeps every other account it is linked to. Only an
  // account of a linkable connection kind takes a link; unlinking is always open.
  // Rome listens to an account of a linkable connection kind only while it has an
  // agent, so the account starts or stops listening.
  app.put("/channels/accounts/:id/agent", async (c) => {
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
      const linked = linkChannelAgent(channels, accounts, id, agent);
      deps.accountListening.changed([linked.channel.id]);
      const result: LinkAccountAgentResult = {
        account: accountView(
          linked.channel,
          linked.agent,
          channels.linkOf(linked.channel.connectionKind),
        ),
      };
      return c.json(result);
    } catch (err) {
      if (err instanceof ChannelRecordNotFound) return c.json({ error: err.message }, 404);
      if (err instanceof ChannelUnbacked) return c.json({ error: err.message }, 409);
      if (err instanceof ChannelNotLinkable) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  return app;
}
