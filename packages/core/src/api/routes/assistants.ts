import { Hono, type Context } from "hono";
import {
  compareAssistants,
  parseAssistantSendRequest,
  type Assistant,
  type AssistantList,
} from "@rome/api-types/assistants";
import { parseMessageCursor } from "@rome/api-types/message";
import {
  sendRefusalMessage,
  timelinePageLimit,
  type OutboxPage,
  type SendRefusal,
} from "@rome/api-types/people";
import { AGENTS_KIND } from "../../connections/integrations/agents.js";
import { isAgentId } from "../../lib/rome-cloud-agents.js";
import { createLogger } from "../../logger.js";
import { discardSend, readOutbox, retrySend, sendToAccount } from "../../people/outbox.js";
import { readPersonTimeline } from "../../people/timeline.js";
import { personMessageStores, timelineAccounts } from "../../people/timeline-sources.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("assistants-api");

// The assistants surface: each agent Rome Cloud lists for this Rome, as one
// chat (docs/domains/chats.md#assistant). The chat is the agent's address on
// the agents channel, so its history, sends and outbox are the People
// surface's, read for that one address instead of for a person's accounts.
// What the guardian writes goes out through the outbox, which starts no agent
// turn, so main answers the assistant and never the guardian here.

export function assistantsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  /** Every assistant Rome Cloud lists, with when its chat last moved. Empty
   *  while Agents is not connected. An unreachable Cloud is a 503, not an
   *  empty list, so the sidebar keeps what it last showed. */
  app.get("/assistants", async (c) => {
    if (!deps.assistants.connected()) {
      return c.json({ assistants: [] } satisfies AssistantList);
    }
    let agents: Awaited<ReturnType<ApiDeps["assistants"]["list"]>>;
    try {
      agents = await deps.assistants.list();
    } catch (err) {
      log.warn("Could not list assistants", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Rome Cloud could not be reached" }, 503);
    }

    const groups = agents.map((agent) => [{ channel: AGENTS_KIND, channelUserId: agent.agentId }]);
    const accounts = await timelineAccounts(deps, groups);
    const stores = personMessageStores(deps);
    const assistants = await Promise.all(
      agents.map(async (agent, index): Promise<Assistant> => {
        const { entries } = await readPersonTimeline(stores, accounts[index] ?? [], { limit: 1 });
        return {
          agentId: agent.agentId,
          name: agent.name,
          kind: agent.kind,
          account: agent.account,
          sameAccount: agent.sameAccount,
          lastMessageAt: entries[0]?.timestamp ?? null,
        };
      }),
    );
    return c.json({ assistants: assistants.sort(compareAssistants) } satisfies AssistantList);
  });

  app.get("/assistants/:agentId/messages", async (c) => {
    const address = addressOf(c);
    if (!address) return unknownAssistant(c);

    const rawCursor = c.req.query("cursor");
    const cursor = parseMessageCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return c.json({ error: "cursor is not a timeline cursor" }, 400);
    }
    const [accounts] = await timelineAccounts(deps, [[address]]);
    return c.json(
      await readPersonTimeline(personMessageStores(deps), accounts ?? [], {
        cursor,
        limit: timelinePageLimit(c.req.query("limit")),
      }),
    );
  });

  /** Write to the assistant as the guardian. 202, as on the People surface:
   *  the channel taking a message is not the message arriving. */
  app.post("/assistants/:agentId/messages", async (c) => {
    const address = addressOf(c);
    if (!address) return unknownAssistant(c);

    const parsed = parseAssistantSendRequest(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const result = await sendToAccount(deps, address, parsed.request.text, parsed.request.id);
    if (!result.ok && "error" in result) return c.json({ error: result.error }, 409);
    return result.ok
      ? c.json(result.message, 202)
      : c.json(
          { error: sendRefusalMessage(result.send), send: result.send } satisfies SendRefusal,
          409,
        );
  });

  app.get("/assistants/:agentId/outbox", async (c) => {
    const address = addressOf(c);
    if (!address) return unknownAssistant(c);

    const [accounts] = await timelineAccounts(deps, [[address]]);
    return c.json({
      messages: await readOutbox(deps, personMessageStores(deps), accounts ?? []),
    } satisfies OutboxPage);
  });

  app.post("/assistants/:agentId/outbox/:messageId/retry", async (c) => {
    const address = addressOf(c);
    if (!address) return unknownAssistant(c);

    const message = await retrySend(deps, [address], c.req.param("messageId"));
    return message
      ? c.json(message, 202)
      : c.json({ error: "No failed message to this assistant with that id" }, 404);
  });

  app.delete("/assistants/:agentId/outbox/:messageId", async (c) => {
    const address = addressOf(c);
    if (!address) return unknownAssistant(c);

    const discarded = await discardSend(deps, [address], c.req.param("messageId"));
    return discarded
      ? c.body(null, 204)
      : c.json({ error: "No dismissable message to this assistant with that id" }, 404);
  });

  return app;
}

/** The assistant's address on the agents channel. Only an agent id is one, so
 *  a name or a typo answers 404 rather than reaching the channel. */
function addressOf(c: Context): { channel: string; channelUserId: string } | null {
  const agentId = c.req.param("agentId") ?? "";
  return isAgentId(agentId) ? { channel: AGENTS_KIND, channelUserId: agentId } : null;
}

function unknownAssistant(c: Context) {
  return c.json({ error: "Unknown assistant" }, 404);
}
