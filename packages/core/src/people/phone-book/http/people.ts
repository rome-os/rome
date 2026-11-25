import { Hono } from "hono";
import { parsePersonFilterLevel, type PeopleList } from "@rome/api-types/people";
import { listPeople } from "../application/list.js";
import type { PhoneBookDeps } from "../deps.js";

// The phone book's people: the listing the chat composer offers people from.
// What a person and their accounts are and how the listing orders and counts
// are the contract's (@rome/api-types/people); the use case is
// `../application/list.ts`. The handler reads the request and picks a status
// code, and holds no rule of its own.

export function peopleRoutes(deps: PhoneBookDeps): Hono {
  const app = new Hono();

  app.get("/people", async (c) => {
    const rawLevel = c.req.query("level");
    const level = parsePersonFilterLevel(rawLevel);
    if (rawLevel != null && rawLevel !== "" && level === null) {
      return c.json({ error: `level must name a bond level or "all"` }, 400);
    }

    return c.json(
      (await listPeople(deps, {
        query: c.req.query("q") ?? "",
        level: level ?? "all",
      })) satisfies PeopleList,
    );
  });

  return app;
}
