import { Hono, type Context } from "hono";
import type { Account, ChatId } from "@rome-os/app-runtime";
import {
  compareAssistants,
  listsAsAssistant,
  parseAssistantSendRequest,
  type Assistant,
  type AssistantList,
} from "@rome/api-types/assistants";
import { messageCursor, parseMessageCursor, type Message } from "@rome/api-types/message";
import { timelinePageLimit, type TimelinePage } from "@rome/api-types/people";
import { AGENTS_KIND } from "../../connections/integrations/agents.js";
import { isAgentId } from "../../lib/rome-cloud-agents.js";
import { createLogger } from "../../logger.js";
import type { SaidMessage } from "../../chats/message.js";
import type { MessageCursor, MessagePage } from "../../chats/message-repository.js";
import { chatKey, placeIn } from "../../chats/place.js";
import { send } from "../../chats/send.js";
import { directPlace } from "../../people/send.js";
import type { ApiDeps } from "../deps.js";
import { respondToSend } from "./people.js";

const log = createLogger("assistants-api");

// The assistants surface: each agent Rome Cloud lists for this Rome, as one
// chat (docs/domains/chats.md#assistant). The chat is the direct message keyed
// by the agent's address on the agents channel: its history is read from that
// place, and the guardian's lines are sent into it as on the People surface.
// What the guardian
// writes goes straight to the channel and starts no agent turn, so main
// answers the assistant and never the guardian here.

export function assistantsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  /** Every assistant Rome Cloud lists, other Romes left out, with when its
   *  chat last moved. Empty while Agents is not connected. An unreachable
   *  Cloud is a 503, not an empty list, so the page keeps the list it last
   *  read. */
  app.get("/assistants", async (c) => {
    if (!deps.assistants.connected()) {
      return c.json({ assistants: [] } satisfies AssistantList);
    }
    let agents: Awaited<ReturnType<ApiDeps["assistants"]["list"]>>;
    try {
      agents = (await deps.assistants.list()).filter(listsAsAssistant);
    } catch (err) {
      log.warn("Could not list assistants", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Rome Cloud could not be reached" }, 503);
    }

    const assistants = await Promise.all(
      agents.map(async (agent): Promise<Assistant> => {
        const [last] = await newest(deps, { platform: AGENTS_KIND, id: agent.agentId }, 1);
        return {
          agentId: agent.agentId,
          name: agent.name,
          kind: agent.kind,
          account: agent.account,
          sameAccount: agent.sameAccount,
          lastMessageAt: last?.timestamp ?? null,
        };
      }),
    );
    return c.json({ assistants: assistants.sort(compareAssistants) } satisfies AssistantList);
  });

  /** The assistant's chat, newest first, read from its place
   *  (docs/domains/chats.md#message). A chat nothing was said in yet reads
   *  as empty. */
  app.get("/assistants/:agentId/messages", async (c) => {
    const address = addressOf(c);
    if (!address) return unknownAssistant(c);

    const rawCursor = c.req.query("cursor");
    const cursor = parseMessageCursor(rawCursor);
    const before = cursor && positionOf(cursor);
    if (rawCursor != null && rawCursor !== "" && !before) {
      return c.json({ error: "cursor is not a timeline cursor" }, 400);
    }
    const page = await messagesAt(deps, address, timelinePageLimit(c.req.query("limit")), before);
    const entries = page.messages.map(timelineEntry).reverse();
    const oldest = entries.at(-1);
    return c.json({
      entries,
      nextCursor: page.older && oldest ? messageCursor(oldest) : null,
    } satisfies TimelinePage);
  });

  /** Write to the assistant as the guardian, answered as on the People
   *  surface: 200 once the channel took it, and the channel's own error when
   *  it refused, so the page shows the error and the guardian sends again. */
  app.post("/assistants/:agentId/messages", async (c) => {
    const address = addressOf(c);
    if (!address) return unknownAssistant(c);

    const parsed = parseAssistantSendRequest(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    // The assistant's chat is the direct message that reaches its address.
    const found = await directPlace(deps, address);
    if (!found.ok) return respondToSend(c, found);
    return respondToSend(c, await send(deps, found.place, { text: parsed.request.text }, found.as));
  });

  return app;
}

/** The assistant's address on the agents channel. Only an agent id is one, so
 *  a name or a typo answers 404 rather than reaching the channel. */
function addressOf(c: Context): Account | null {
  const agentId = c.req.param("agentId") ?? "";
  return isAgentId(agentId) ? { platform: AGENTS_KIND, id: agentId } : null;
}

function unknownAssistant(c: Context) {
  return c.json({ error: "Unknown assistant" }, 404);
}

/** The prefix a timeline gives Rome's transcript rows, so a message keeps the
 *  ref the People timeline gave it. */
const REF_PREFIX = "agent:";

/** A message as the timeline wire shows it. */
function timelineEntry(message: SaidMessage): Message {
  const inbound = message.direction === "toRome";
  return {
    source: message.place.chat.platform,
    timestamp: Math.floor(message.at.getTime() / 1000),
    body: message.body.text === "" ? null : message.body.text,
    direction: inbound ? "inbound" : "outbound",
    ref: `${REF_PREFIX}${message.id}`,
    ...(inbound && (message.saidBy || message.senderName !== undefined)
      ? {
          sender: {
            id: message.saidBy?.account.id ?? null,
            name: message.senderName ?? null,
          },
        }
      : {}),
  };
}

/** Where a timeline cursor stands in the chat's messages, or null when it
 *  names no message of Rome's transcript. */
function positionOf(cursor: Message): MessageCursor | null {
  if (!cursor.ref.startsWith(REF_PREFIX)) return null;
  return { at: new Date(cursor.timestamp * 1000), id: cursor.ref.slice(REF_PREFIX.length) };
}

/** The assistant's chat read back from `before`, or from its newest message.
 *  Each assistant is one direct message, keyed by the assistant's own id, so
 *  its history reads the same whether or not Rome can send there now. */
function messagesAt(
  deps: ApiDeps,
  address: Account,
  limit: number,
  before?: MessageCursor | null,
): Promise<MessagePage> {
  const place = placeIn(chatKey(address.platform, address.id as ChatId));
  return deps.chatMessages.read(place, { before: before ?? null, limit });
}

/** The newest `limit` messages of the assistant's chat, newest first. */
async function newest(deps: ApiDeps, address: Account, limit: number): Promise<Message[]> {
  const page = await messagesAt(deps, address, limit);
  return page.messages.map(timelineEntry).reverse();
}
