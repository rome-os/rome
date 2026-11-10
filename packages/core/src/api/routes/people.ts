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
  parseUpdatePersonRequest,
  personMatchesLevel,
  personMatchesQuery,
  sendRefusalMessage,
  timelinePageLimit,
  type PeopleList,
  type SendRefusal,
  type LinkCodeResponse,
} from "@rome/api-types/people";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { currentSessionActor } from "../../access/session-actor.js";
import { parseMessageCursor } from "@rome/api-types/message";
import { platformOf } from "@rome/api-types/platform";
import { createPerson } from "../../people/create.js";
import { deletePerson } from "../../people/delete.js";
import { mergePeople } from "../../people/merge.js";
import { findPerson, readPeople, readPerson } from "../../people/resource.js";
import { updatePerson } from "../../people/update.js";
import { send, type SendResult } from "../../connections/send.js";
import { asGuardian, directPlace } from "../../people/send.js";
import { readAccountTimeline } from "../../people/timeline.js";
import {
  guardianChannels,
  personMessageStores,
  timelineAccounts,
} from "../../people/timeline-sources.js";
import { accountOfWire, wireOf } from "../../people/wire.js";
import type { ApiDeps } from "../deps.js";

// The People surface. What a person and their accounts are, how the listing
// orders and counts, what a valid create is, when a link may be taken and what
// a refused one answers are the contract's (@rome/api-types/people);
// serializing a person is `src/people/resource.ts`, creating one is
// `src/people/create.ts`, editing one `src/people/update.ts`, absorbing one
// `src/people/merge.ts`, deleting one `src/people/delete.ts`, and which stores an
// account's history is read from is the rest of `src/people/`. The compare-and-swap a link rides on is the person
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

  // A redeemed code makes its sender the guardian, so only the guardian may
  // see one, and only from the dashboard itself.
  app.post("/people/link-code", async (c) => {
    if ((await currentSessionActor())?.kind !== "guardian")
      return c.json({ error: "Guardian authentication required" }, 403);
    if (!isSameOriginMutationRequest(c.req.raw))
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    c.header("Cache-Control", "no-store");
    return c.json(deps.guardianLinkCodes.issue() satisfies LinkCodeResponse, 201);
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

  // 204: the person is gone, so there is no resource to answer with. Their
  // accounts are strangers again, which the directory read shows.
  app.delete("/people/:id", async (c) => {
    const result = await deletePerson(deps, c.req.param("id"));
    if ("unknown" in result) return c.json({ error: "Unknown person" }, 404);
    // 400 for the same reason as a refused edit: the request names a change the
    // guardian cannot have.
    if ("refused" in result) return c.json({ error: result.refused }, 400);
    return c.body(null, 204);
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

    const account = accountOfWire(request);
    const result = request.transferFrom
      ? await deps.peopleRepo.move(account, request.transferFrom, person.id)
      : await deps.peopleRepo.link(account, person.id);
    if (!result.linked) {
      const { holder } = result;
      return c.json(
        linkConflict(
          wireOf(account),
          holder && { id: holder.personId, displayName: holder.personName },
        ),
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
    const unlinked = await deps.peopleRepo.unlink(
      accountOfWire({
        channel: c.req.param("channel"),
        channelUserId: c.req.param("channelUserId"),
      }),
      person.id,
    );
    if (!unlinked) return c.json({ error: "Unknown account" }, 404);

    return respondWithPerson(deps, c, person.id);
  });

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
    const person = await findPerson(deps, c.req.param("id"));
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
    const person = await findPerson(deps, c.req.param("id"));
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

/** The person a write just changed, read back through the same serializer the
 *  reads answer with, so a client can render the outcome without a second
 *  request. */
async function respondWithPerson(deps: ApiDeps, c: Context, id: string) {
  const person = await readPerson(deps, id);
  return person ? c.json(person) : c.json({ error: "Unknown person" }, 404);
}

/** The one answer every send route gives, so the dashboard reads one shape. */
export function respondToSend(c: Context, result: SendResult) {
  if (result.ok) return c.json(result.sent, 200);
  if ("invalid" in result) return c.json({ error: result.invalid }, 400);
  if ("error" in result) return c.json({ error: result.error }, 502);
  return c.json(
    { error: sendRefusalMessage(result.send), send: result.send } satisfies SendRefusal,
    409,
  );
}
