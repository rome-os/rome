import { Hono, type Context } from "hono";
import {
  comparePeople,
  countPeople,
  linkConflict,
  parseCreatePersonRequest,
  parseLinkAccountRequest,
  parseMergeRequest,
  parsePersonFilterLevel,
  parseSendMessageRequest,
  parseTimelineCursor,
  parseUpdatePersonRequest,
  personMatchesLevel,
  personMatchesQuery,
  timelinePageLimit,
  type AccountSendState,
  type OutboxPage,
  type PeopleList,
  type SendRefusal,
} from "@rome/api-types/people";
import { createPerson } from "../../people/create.js";
import { mergePeople } from "../../people/merge.js";
import { discardSend, readOutbox, retrySend, sendToAccount } from "../../people/outbox.js";
import { findPerson, readPeople, readPerson } from "../../people/resource.js";
import { updatePerson } from "../../people/update.js";
import { readPersonTimeline } from "../../people/timeline.js";
import { personMessageStores, timelineAccounts } from "../../people/timeline-sources.js";
import type { ApiDeps } from "../deps.js";

// The People surface. What a person and their accounts are, how the listing
// orders and counts, what a valid create is, when a link may be taken and what
// a refused one answers are the contract's (@rome/api-types/people);
// serializing a person is `src/people/resource.ts`, creating one is
// `src/people/create.ts`, editing one `src/people/update.ts`, absorbing one
// `src/people/merge.ts`, and which stores a history is merged from is the rest
// of `src/people/`. The compare-and-swap a link rides on is the person
// repository's, because only a transaction there can decide it. These handlers
// read the request and pick a status code, and hold no rule of their own.

export function peopleRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/people", async (c) => {
    const rawLevel = c.req.query("level");
    const level = parsePersonFilterLevel(rawLevel);
    if (rawLevel != null && rawLevel !== "" && level === null) {
      return c.json({ error: `level must name a bond level or "all"` }, 400);
    }

    // The whole `?q=` match, before `?level=` narrows it: the counts describe
    // it, and every chip's number has to stay true while another chip is the
    // one selected.
    const matching = (await readPeople(deps)).filter((person) =>
      personMatchesQuery(person, c.req.query("q") ?? ""),
    );

    return c.json({
      people: matching
        .filter((person) => personMatchesLevel(person, level ?? "all"))
        .sort(comparePeople),
      counts: countPeople(matching),
    } satisfies PeopleList);
  });

  app.post("/people", async (c) => {
    const parsed = parseCreatePersonRequest(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const created = await createPerson(deps, parsed.person);
    // 409 rather than 400: the body is well formed and the guardian may well
    // have meant it. A held account is a fact about Rome's state, which a
    // transfer can change, rather than a mistake in the request.
    return "conflict" in created ? c.json(created.conflict, 409) : c.json(created.person, 201);
  });

  app.get("/people/:id", async (c) => {
    const person = await readPerson(deps, c.req.param("id"));
    return person ? c.json(person) : c.json({ error: "Unknown person" }, 404);
  });

  app.patch("/people/:id", async (c) => {
    const parsed = parseUpdatePersonRequest(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const result = await updatePerson(deps, c.req.param("id"), parsed.update);
    if ("unknown" in result) return c.json({ error: "Unknown person" }, 404);
    // 400 rather than 403: nothing about the caller could make this edit
    // land, since the guardian is the only caller there is. The request names
    // a change the person does not have.
    if ("refused" in result) return c.json({ error: result.refused }, 400);
    return c.json(result.person);
  });

  // The duplicate names itself in the body and the survivor in the path, so a
  // client that renders the merge reads the survivor back from the response it
  // already has to handle.
  app.post("/people/:id/merge", async (c) => {
    const into = c.req.param("id");
    const parsed = parseMergeRequest(await c.req.json().catch(() => null), into);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const result = await mergePeople(deps, into, parsed.merge.from);
    if ("unknown" in result) return c.json({ error: "Unknown person" }, 404);
    if ("refused" in result) return c.json({ error: result.refused }, 400);
    return c.json(result.person);
  });

  app.post("/people/:id/accounts", async (c) => {
    const person = await findPerson(deps, c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    const request = parseLinkAccountRequest(await c.req.json().catch(() => null));
    if (!request) return c.json({ error: "channel and channelUserId are required" }, 400);

    const result = await deps.personMappingRepo.linkAccount({
      personId: person.id,
      channel: request.channel,
      channelUserId: request.channelUserId,
      transferFrom: request.transferFrom,
    });
    if (!result.linked) {
      const { holder } = result;
      return c.json(
        linkConflict(request, holder && { id: holder.personId, displayName: holder.personName }),
        409,
      );
    }

    return respondWithPerson(deps, c, person.id);
  });

  // The identifier takes the rest of the path, separators included. A channel
  // mints its own addresses and channels are open — a Rome App brings one — so
  // there is no format to promise they avoid "/", and a plain segment would
  // answer 404 for an account that exists rather than unlinking it. The channel
  // name above stays one segment, which `accountRef` already requires of it.
  app.delete("/people/:id/accounts/:channel/:channelUserId{.+}", async (c) => {
    const person = await findPerson(deps, c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    // A link this person does not hold is one this route cannot drop, whoever
    // else holds it: unlinking is not a way to reach into another person's
    // accounts, and reporting success would tell the caller their view was
    // right when it was stale.
    const unlinked = await deps.personMappingRepo.unlinkAccount(
      person.id,
      c.req.param("channel"),
      c.req.param("channelUserId"),
    );
    if (!unlinked) return c.json({ error: "Unknown account" }, 404);

    return respondWithPerson(deps, c, person.id);
  });

  /**
   * Say something to one of this person's accounts.
   *
   * 202 rather than 200: the channel taking a message is not the message
   * arriving, and the body says which of those has happened. A refusal answers
   * the same `send` state the person read carries, so a client that raced a
   * disconnect renders the reason it would already have shown.
   */
  app.post("/people/:id/messages", async (c) => {
    const person = await findPerson(deps, c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    const parsed = parseSendMessageRequest(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    // The account has to be one of theirs. A client that names another
    // person's address is not making a request this person's page can answer,
    // and sending anyway would deliver a message the guardian addressed to
    // someone else.
    const held = person.channelMappings.some(
      (mapping) =>
        mapping.channel === parsed.request.channel &&
        mapping.channelUserId === parsed.request.channelUserId,
    );
    if (!held) {
      return c.json({ error: "That account is not linked to this person" }, 400);
    }

    const result = await sendToAccount(deps, parsed.request, parsed.request.text);
    return result.ok
      ? c.json(result.message, 202)
      : c.json(
          { error: refusalMessage(result.send), send: result.send } satisfies SendRefusal,
          409,
        );
  });

  /** Every send of this person's still in flight. Unpaged — an outbox long
   *  enough to page is an incident rather than a listing. */
  app.get("/people/:id/outbox", async (c) => {
    const person = await findPerson(deps, c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    const [accounts] = await timelineAccounts(deps, [person.channelMappings]);
    return c.json({
      messages: await readOutbox(deps, personMessageStores(deps), accounts),
    } satisfies OutboxPage);
  });

  /**
   * Try a failed send again. Under its own id, so a retry never reads as a
   * second message the guardian did not write.
   *
   * Both outbox mutations are scoped to the person in the path. A message id
   * is not a capability, and the person named is the one whose outbox this is
   * — a row of somebody else's reached through this address is a 404, not a
   * shortcut.
   */
  app.post("/people/:id/outbox/:messageId/retry", async (c) => {
    const person = await findPerson(deps, c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    const message = await retrySend(deps, person.channelMappings, c.req.param("messageId"));
    return message
      ? c.json(message, 202)
      : c.json({ error: "No failed message of theirs with that id" }, 404);
  });

  /** Give up on a failed send. The only way a row leaves the outbox without
   *  having been delivered — a send still in flight may yet arrive, and
   *  dropping its record would leave the guardian with no account of it. */
  app.delete("/people/:id/outbox/:messageId", async (c) => {
    const person = await findPerson(deps, c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    const discarded = await discardSend(deps, person.channelMappings, c.req.param("messageId"));
    return discarded
      ? c.body(null, 204)
      : c.json({ error: "No failed message of theirs with that id" }, 404);
  });

  app.get("/people/:id/messages", async (c) => {
    const person = await findPerson(deps, c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    const rawCursor = c.req.query("cursor");
    const cursor = parseTimelineCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return c.json({ error: "cursor is not a timeline cursor" }, 400);
    }

    // A channel this person holds no account on answers an empty page rather
    // than a 400: channels are open — a Rome App brings its own — so there is
    // no set of names to check one against, and "no history there" is the true
    // answer for every name that is not a typo.
    const channel = c.req.query("channel");
    const [accounts] = await timelineAccounts(deps, [person.channelMappings]);

    return c.json(
      await readPersonTimeline(
        personMessageStores(deps),
        accounts.filter((account) => !channel || account.channel === channel),
        { cursor, limit: timelinePageLimit(c.req.query("limit")) },
      ),
    );
  });

  return app;
}

/** The person a write just changed, read back through the same serializer the
 *  reads answer with, so a client can render the outcome without a second
 *  request. */
async function respondWithPerson(deps: ApiDeps, c: Context, id: string) {
  const person = await readPerson(deps, id);
  return person ? c.json(person) : c.json({ error: "Unknown person" }, 404);
}

/**
 * The line a refusal carries when a client has nothing better.
 *
 * A fallback, not the copy: the dashboard renders `send` through its own
 * locale files, because why a channel cannot be written to is a fact about the
 * channel and every surface that states it has to state it in the reader's
 * language.
 */
function refusalMessage(send: Exclude<AccountSendState, "yes">): string {
  switch (send) {
    case "not-connected":
      return "That channel is not connected";
    case "unsupported":
      return "Rome cannot send on that channel";
    case "no-conversation":
      return "Rome has no conversation open with that account";
  }
}
