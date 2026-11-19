import { Hono } from "hono";
import { parseSendMessageRequest, timelinePageLimit } from "@rome/api-types/people";
import { parseMessageCursor } from "@rome/api-types/message";
import { platformOf } from "@rome/api-types/platform";
import { send } from "../../../chats/send.js";
import {
  asGuardian,
  directPlace,
  guardianChannels,
  personMessageStores,
  readAccountTimeline,
  timelineAccounts,
} from "../../../people/person-history/index.js";
import { accountOfWire } from "../../../people/model/wire.js";
import type { ApiDeps } from "../../deps.js";
import { respondToSend } from "../send-response.js";

// A person's history: one of their accounts' messages, paged, and sending to
// that account. Which stores an account's history is read from, and where a
// send goes out from, are `src/people/person-history/`. These handlers read the
// request and pick a status code, and hold no rule of their own.

export function personHistoryRoutes(deps: ApiDeps): Hono {
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
    const person = await deps.peopleRepo.byId(c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    const parsed = parseSendMessageRequest(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    // The account has to be one of theirs. A client that names another
    // person's address is not making a request this person's page can answer,
    // and sending anyway would deliver a message the guardian addressed to
    // someone else.
    const account = accountOfWire(parsed.request);
    const held = person.links.some(
      (link) => link.platform === account.platform && link.id === account.id,
    );
    if (!held) {
      return c.json({ error: "That account is not linked to this person" }, 400);
    }

    // The account the message goes out from has to be one of Rome's accounts
    // on the link's platform. Rome never substitutes another for it.
    // `directPlace` and `send` check it.
    // TODO(people-send-from dashboard PR): require `from` once the dashboard
    // sends it. Until then a send without it goes out from Rome's only account
    // on the platform, and is refused while Rome holds several.
    const from = parsed.request.from;
    const guardians = await guardianChannels(deps);
    const found = await directPlace(asGuardian(deps, guardians), account, from);
    if (!found.ok) return respondToSend(c, found);
    return respondToSend(c, await send(deps, found.place, { text: parsed.request.text }, found.as));
  });

  /**
   * One of the person's accounts, its history paged newest first. A person
   * has no history joined across their accounts, so the account is required:
   * `?channel=` names its platform, and a kind of connection reads as its
   * platform, and `?channelUserId=` its address. An account this person does
   * not hold is refused, as a send to one is.
   */
  app.get("/people/:id/messages", async (c) => {
    const person = await deps.peopleRepo.byId(c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

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
    const link = person.links.find(
      (held) => held.platform === platformOf(channel) && held.id === channelUserId,
    );
    if (!link) return c.json({ error: "That account is not linked to this person" }, 400);

    // The fold puts every address of the account on it, so the link is
    // matched by its address among them, the rule the person read's
    // `latestAt` uses too.
    const guardians = await guardianChannels(deps);
    const [accounts] = await timelineAccounts({ ...deps, guardians }, [person.links]);
    return c.json(
      await readAccountTimeline(
        personMessageStores(deps),
        (accounts ?? []).filter(
          (account) => account.channel === link.platform && account.addresses.includes(link.id),
        ),
        { cursor, limit: timelinePageLimit(c.req.query("limit")) },
      ),
    );
  });

  return app;
}
