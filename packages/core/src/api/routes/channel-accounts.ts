// Accounts and their linked agents. An account is a channel, as the dashboard
// shows it; one whose Connection was deleted is listed with no Connection.
// Vocabulary: docs/concepts/messaging.md#channels.
// Invariants: docs/architecture/channels.md#linked-agents.

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
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import type { ApiDeps } from "../deps.js";

const linkBodySchema: z.ZodType<LinkAccountAgentRequest> = z.object({
  agent: z.string().trim().min(1).nullable(),
});

function accountView(record: ChannelRecord): ChannelAccount {
  return {
    id: record.id,
    service: record.service,
    platform: record.platform,
    connectionId: record.connectionId,
    agent: record.agent,
  };
}

export function channelAccountsRoutes(deps: Pick<ApiDeps, "db" | "agentLoader">): Hono {
  const app = new Hono();
  const channels = new ChannelRecordsRepository(deps.db);

  app.get("/channels/accounts", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ accounts: channels.all().map(accountView) });
  });

  // Link an agent to an account, or unlink it with `null`. Linking an agent
  // other than main that has an account on the same platform takes it off
  // that account. Only an account of a linkable service takes a link;
  // unlinking is always open.
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
      const outcome = channels.link(id, agent);
      const result: LinkAccountAgentResult = {
        account: accountView(outcome.channel),
        unlinkedFrom: outcome.unlinkedFrom,
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
