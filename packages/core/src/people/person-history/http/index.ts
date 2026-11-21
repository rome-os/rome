import { type Context, Hono } from "hono";
import { parseSendMessageRequest, timelinePageLimit } from "@rome/api-types/people";
import { parseMessageCursor } from "@rome/api-types/message";
import {
  type AccountRefusal,
  readAccountMessages,
  sendToAccount,
} from "../application/account-messages.js";
import type { PersonHistoryDeps } from "../deps.js";
import { accountOfWire } from "../../model/wire.js";
import { respondToSend } from "./send-response.js";

// A person's history over HTTP: one of their accounts' messages, paged, and
// sending to that account. The rules are in ../application/. These handlers
// read the request and pick a status code.

/** The answer to an account the person does not hold, or a person who does not exist. */
function respondToRefusal(c: Context, { refused }: AccountRefusal) {
  return refused === "unknown person"
    ? c.json({ error: "Unknown person" }, 404)
    : c.json({ error: "That account is not linked to this person" }, 400);
}

export function personHistoryRoutes(deps: PersonHistoryDeps): Hono {
  const app = new Hono();

  /**
   * Say something to one of this person's accounts.
   *
   * One channel call inside the request. 200 once the channel took the
   * message, 502 with the channel's own words when it refused, so the composer
   * keeps the text and the guardian sends again. A refusal Rome makes before
   * asking the channel answers the same `send` state the person read carries,
   * so a client that raced a disconnect renders the reason it would already
   * have shown.
   */
  app.post("/people/:id/messages", async (c) => {
    const personId = c.req.param("id");
    if (!(await deps.peopleRepo.byId(personId))) return c.json({ error: "Unknown person" }, 404);
    const parsed = parseSendMessageRequest(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const result = await sendToAccount(deps, personId, parsed.request);
    if ("refused" in result) return respondToRefusal(c, result);
    return respondToSend(c, result);
  });

  /**
   * One of the person's accounts, its history paged newest first.
   * `?channel=` names its platform, and a kind of connection reads as its
   * platform, and `?channelUserId=` its address. An account this person does
   * not hold is refused, as a send to one is.
   */
  app.get("/people/:id/messages", async (c) => {
    const personId = c.req.param("id");
    if (!(await deps.peopleRepo.byId(personId))) return c.json({ error: "Unknown person" }, 404);

    const rawCursor = c.req.query("cursor");
    const cursor = parseMessageCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return c.json({ error: "cursor is not a timeline cursor" }, 400);
    }
    const channel = c.req.query("channel");
    const channelUserId = c.req.query("channelUserId");
    if (!channel || !channelUserId) {
      return c.json({ error: "channel and channelUserId must name one account" }, 400);
    }

    const result = await readAccountMessages(
      deps,
      personId,
      accountOfWire({ channel, channelUserId }),
      { cursor, limit: timelinePageLimit(c.req.query("limit")) },
    );
    if ("refused" in result) return respondToRefusal(c, result);
    return c.json(result);
  });

  return app;
}
