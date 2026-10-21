import { Hono, type Context } from "hono";
import {
  accountPageLimit,
  isChannelIdentifier,
  parseAccountCursor,
  parseAccountState,
  parseStreamCursor,
  sliceAccountDirectory,
  sliceAccountStream,
  type AccountState,
  type StreamAccount,
} from "@rome/api-types/people";
import { readAccountDirectory, readAccountStream } from "../../people/account-directory.js";
import type { ApiDeps } from "../deps.js";

// The account reads: every account Rome has observed, and what the guardian has
// decided about each. What a page is, how it is ordered, how it resumes and
// what its numbers count are the contract's (@rome/api-types/people). Which
// sources they are folded from is `src/people/account-directory.ts`. These
// routes are the join between a query string and those two, and hold no rule of
// their own.
//
// Two of them, because two surfaces ask two questions. `/accounts` is the
// contacts list: every account, ordered by name, carrying nothing about what
// anyone said. `/accounts/stream` is the recents surface: ordered by what
// happened last, carrying the line to preview, and holding only the accounts
// something has happened on.
//
// Both are reads. Placing an account is a write on the person's own route;
// dismissing and restoring one are `./account-decisions.ts`.

export function accountsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  /**
   * The stream read already running, which a request arriving meanwhile joins
   * instead of starting its own. The stream asks every live store for every
   * account's newest message, which can take a while on a slow source, and the
   * People page polls it every 30 seconds and refetches each loaded page — so
   * without this, reads pile up faster than they finish. Only shared while in
   * flight: a request after it settles reads afresh.
   */
  let streamRead: Promise<StreamAccount[]> | null = null;
  const readStream = (): Promise<StreamAccount[]> => {
    if (!streamRead) {
      const read = readAccountStream(deps);
      streamRead = read;
      const settle = () => {
        if (streamRead === read) streamRead = null;
      };
      read.then(settle, settle);
    }
    return streamRead;
  };

  /** The `?state=` both reads narrow by, or the 400 a value that names no state
   *  earns — answering it as the whole listing would silently show the wrong
   *  accounts. */
  const readState = (c: Context): { state: AccountState | null } | { error: string } => {
    const raw = c.req.query("state");
    const state = parseAccountState(raw);
    if (raw != null && raw !== "" && state === null) {
      return { error: "state must name an account state" };
    }
    return { state };
  };

  app.get("/accounts", async (c) => {
    const state = readState(c);
    if ("error" in state) return c.json({ error: state.error }, 400);

    const channel = c.req.query("channel") || null;
    if (channel !== null && !isChannelIdentifier(channel)) {
      return c.json({ error: "channel must name a channel" }, 400);
    }

    const rawCursor = c.req.query("cursor");
    const cursor = parseAccountCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return c.json({ error: "cursor is not an account cursor" }, 400);
    }

    return c.json(
      sliceAccountDirectory(await readAccountDirectory(deps), {
        query: c.req.query("q"),
        channel,
        state: state.state,
        cursor,
        limit: accountPageLimit(c.req.query("limit")),
      }),
    );
  });

  app.get("/accounts/stream", async (c) => {
    const state = readState(c);
    if ("error" in state) return c.json({ error: state.error }, 400);

    const rawCursor = c.req.query("cursor");
    const cursor = parseStreamCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return c.json({ error: "cursor is not a stream cursor" }, 400);
    }

    return c.json(
      sliceAccountStream(await readStream(), {
        query: c.req.query("q"),
        state: state.state,
        cursor,
        limit: accountPageLimit(c.req.query("limit")),
      }),
    );
  });

  return app;
}
