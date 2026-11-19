import { Hono, type Context } from "hono";
import {
  comparePeople,
  countPeople,
  linkConflict,
  parseCreatePersonRequest,
  parseLinkAccountRequest,
  parseMergeRequest,
  parsePersonFilterLevel,
  parseUpdatePersonRequest,
  personMatchesLevel,
  personMatchesQuery,
  type PeopleList,
} from "@rome/api-types/people";
import {
  createPerson,
  deletePerson,
  findPerson,
  mergePeople,
  readPeople,
  readPerson,
  updatePerson,
} from "../../../../people/phone-book/index.js";
import { accountOfWire, wireOf } from "../../../../people/model/wire.js";
import type { ApiDeps } from "../../../deps.js";

// The phone book's people: listing, creating, editing, merging and deleting
// people, and linking accounts to them. What a person and their accounts are,
// how the listing orders and counts, what a valid create is, when a link may be
// taken and what a refused one answers are the contract's
// (@rome/api-types/people); the use cases are `src/people/phone-book/`. The
// compare-and-swap a link rides on is the people repository's, because only a
// transaction there can decide it. These handlers read the request and pick a
// status code, and hold no rule of their own.

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

  return app;
}

/** The person a write just changed, read back through the same serializer the
 *  reads answer with, so a client can render the outcome without a second
 *  request. */
async function respondWithPerson(deps: ApiDeps, c: Context, id: string) {
  const person = await readPerson(deps, id);
  return person ? c.json(person) : c.json({ error: "Unknown person" }, 404);
}
