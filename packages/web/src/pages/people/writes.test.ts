// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import type { TFunction } from "i18next";
import { linkConflict, type DirectoryAccount } from "@rome/api-types/people";
import i18n from "@/i18n";
import { createPerson, dismissAccount, linkAccount, mergePeople } from "./writes";

// The People page's writes, at the wire: what each answer becomes, which is not
// visible from a rendered row. The requests themselves run against the contract's
// handlers in `writes-against-mock.test.ts`.
//
// The contract's own `linkConflict` phrases the 409s, so a fixture cannot drift
// from the wording a route refuses in.

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => rs.restoreAllMocks());

const t = i18n.getFixedT("en", "people") as TFunction<"people">;

const ACCOUNT: DirectoryAccount = {
  channel: "whatsapp",
  channelUserId: "6591234472@s.whatsapp.net",
  addresses: ["6591234472", "6591234472@s.whatsapp.net"],
  displayName: "Rachel Lim",
  state: "dismissed",
  personId: null,
  personName: null,
};

const REF = { channel: "whatsapp", channelUserId: "6591234472@s.whatsapp.net" };

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

/** Answers every request with one payload, and records what was sent. */
function stubFetch(payload: unknown, status = 200) {
  const sent: Sent[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    sent.push({
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: status < 400,
      status,
      json: async () => payload,
    } as Response;
  }) as typeof fetch);
  return sent;
}

describe("people writes — the account path", () => {
  it("leaves an identifier's own separators in the path", async () => {
    const sent = stubFetch(ACCOUNT);

    await dismissAccount({ channel: "matrix", channelUserId: "room/42" }, t);

    // The route takes the rest of the path before the verb, separators
    // included — a channel mints its own addresses, and a percent-escaped "/"
    // would be a segment the route never sees.
    expect(sent[0]!.url).toBe("/api/accounts/matrix/room/42/dismiss");
  });
});

describe("people writes — what an answer becomes", () => {
  it("hands back a refused link as the conflict it is, owner included", async () => {
    const conflict = linkConflict(REF, { id: "mira", displayName: "Mira Chen" });
    stubFetch(conflict, 409);

    const result = await linkAccount("wei-chen", REF, t);

    // Not an error string: the page has to name the owner and offer a transfer,
    // and a message it would have to parse is not a person's id.
    expect(result).toEqual({ ok: false, conflict });
  });

  it("reads a conflict on a create the same way", async () => {
    const conflict = linkConflict(REF, { id: "mira", displayName: "Mira Chen" });
    stubFetch(conflict, 409);

    const result = await createPerson({ displayName: "Rachel Lim", accounts: [REF] }, t);

    expect(result).toEqual({ ok: false, conflict });
  });

  it("shows a rejected request in the words the route refused it with", async () => {
    stubFetch({ error: "displayName is required" }, 400);

    const result = await createPerson({ displayName: " " }, t);

    // The status rides along beside the message: most callers render the line
    // and ignore it, and the outbox gestures read it to tell a row that is not
    // theirs to act on from a write that actually failed.
    expect(result).toEqual({ ok: false, message: "displayName is required", status: 400 });
  });

  it("never puts a server fault on screen in its own words", async () => {
    stubFetch({ error: "SQLITE_BUSY: database is locked" }, 500);

    const result = await mergePeople("wei-chen", "duplicate", t);

    // A 5xx body carries the same shape as a 4xx one and not the same meaning:
    // the API error handler serializes an unhandled exception into it.
    expect(result).toEqual({ ok: false, message: t("errors.requestFailed"), status: 500 });
  });

  it("says the server was unreachable rather than throwing at a click handler", async () => {
    rs.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const result = await dismissAccount(REF, t);

    expect(result).toEqual({ ok: false, message: t("errors.network") });
  });
});
