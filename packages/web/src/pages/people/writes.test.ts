// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import type { TFunction } from "i18next";
import { linkConflict, type DirectoryAccount, type PersonResource } from "@rome/api-types/people";
import i18n from "@/i18n";
import {
  createPerson,
  dismissAccount,
  linkAccount,
  mergePeople,
  restoreAccount,
  unlinkAccount,
  updatePerson,
} from "./writes";

// The People page's writes, at the wire. What is pinned here is the request each
// gesture sends — verb, path, body — and what each answer becomes, because those
// are the two halves the page is written against and neither is visible from a
// rendered row.
//
// The contract's own `linkConflict` phrases the 409s, so a fixture cannot drift
// from the wording a route refuses in.

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => rs.restoreAllMocks());

const t = i18n.getFixedT("en", "people") as TFunction<"people">;

const PERSON: PersonResource = {
  id: "wei-chen",
  displayName: "Wei Chen",
  bondLevel: "acquaintance",
  accounts: [],
  messageCount: 0,
  latest: null,
};

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

describe("people writes — the request each verb sends", () => {
  it("creates a person and links the account it came from, in one request", async () => {
    const sent = stubFetch(PERSON, 201);

    const result = await createPerson(
      { displayName: "Rachel Lim", bondLevel: "acquaintance", accounts: [REF] },
      t,
    );

    expect(result).toEqual({ ok: true, value: PERSON });
    // Atomic create-and-link: one request, so a created person never exists
    // without the account that was the reason to create them.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: "/api/people", method: "POST" });
    expect(sent[0]!.body).toEqual({
      displayName: "Rachel Lim",
      bondLevel: "acquaintance",
      accounts: [REF],
    });
  });

  it("links an account onto a person the roster already holds", async () => {
    const sent = stubFetch(PERSON);

    await linkAccount("wei-chen", REF, t);

    expect(sent[0]).toMatchObject({ url: "/api/people/wei-chen/accounts", method: "POST" });
    // No `transferFrom` when nobody holds it: the contract only asks for one
    // when the link is a transfer.
    expect(sent[0]!.body).toEqual(REF);
  });

  it("names the person a transfer takes the account from", async () => {
    const sent = stubFetch(PERSON);

    await linkAccount("wei-chen", { ...REF, transferFrom: "mira" }, t);

    expect(sent[0]!.body).toEqual({ ...REF, transferFrom: "mira" });
  });

  it("unlinks by naming the account in the path, not in a body", async () => {
    const sent = stubFetch(PERSON);

    await unlinkAccount("wei-chen", REF, t);

    expect(sent[0]).toMatchObject({
      method: "DELETE",
      url: "/api/people/wei-chen/accounts/whatsapp/6591234472%40s.whatsapp.net",
    });
  });

  it("dismisses and restores the same account at the same address", async () => {
    const dismissed = stubFetch(ACCOUNT);
    await dismissAccount(REF, t);
    expect(dismissed[0]).toMatchObject({
      method: "POST",
      url: "/api/accounts/whatsapp/6591234472%40s.whatsapp.net/dismiss",
    });

    rs.restoreAllMocks();
    const restored = stubFetch({ ...ACCOUNT, state: "unlinked" });
    await restoreAccount(REF, t);
    expect(restored[0]).toMatchObject({
      method: "POST",
      url: "/api/accounts/whatsapp/6591234472%40s.whatsapp.net/restore",
    });
  });

  it("leaves an identifier's own separators in the path", async () => {
    const sent = stubFetch(ACCOUNT);

    await dismissAccount({ channel: "matrix", channelUserId: "room/42" }, t);

    // The route takes the rest of the path before the verb, separators
    // included — a channel mints its own addresses, and a percent-escaped "/"
    // would be a segment the route never sees.
    expect(sent[0]!.url).toBe("/api/accounts/matrix/room/42/dismiss");
  });

  it("merges the duplicate named in the body into the survivor named in the path", async () => {
    const sent = stubFetch(PERSON);

    await mergePeople("wei-chen", "wei-chen-duplicate", t);

    expect(sent[0]).toMatchObject({ url: "/api/people/wei-chen/merge", method: "POST" });
    expect(sent[0]!.body).toEqual({ from: "wei-chen-duplicate" });
  });

  it("changes a bond with a patch that names only the bond", async () => {
    const sent = stubFetch({ ...PERSON, bondLevel: "inner-circle" });

    await updatePerson("wei-chen", { bondLevel: "inner-circle" }, t);

    expect(sent[0]).toMatchObject({ url: "/api/people/wei-chen", method: "PATCH" });
    // An omitted field is one the update leaves alone, so a bond change must
    // not carry a name and blank it.
    expect(sent[0]!.body).toEqual({ bondLevel: "inner-circle" });
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
