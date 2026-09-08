// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  countPeople,
  linkConflict,
  parseAccountCursor,
  parseAccountState,
  parsePersonFilterLevel,
  parseStreamCursor,
  personMatchesLevel,
  personMatchesQuery,
  sliceAccountDirectory,
  sliceAccountStream,
  type AccountDynamic,
  type DirectoryAccount,
  type PersonResource,
  type StreamAccount,
} from "@rome/api-types/people";
import i18n from "@/i18n";
import PeoplePage, { PeopleIndexRedirect } from "./PeoplePage";

// The People page as the guardian drives it: a stream that routes to whoever
// has something new, and a directory — a contacts list — that reads the roster.
// The derivations behind grouping and counts are pinned in
// `people/people-model.test.ts`; what is under test here is the page wiring —
// which of the two account reads a view sends, what it shows afterwards, and
// where a click takes the guardian.
//
// The backend is stubbed through the contract's own helpers rather than
// restated, so a fixture cannot drift from the routes on ordering, filtering,
// counting or paging.

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // Radix Select and the chip rail drive pointer capture and scroll, neither of
  // which jsdom implements.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

/** Every field any of the contract's write bodies carries, so one shape reads
 *  them all — the mock below dispatches on the path, not on the body. */
interface WriteBody {
  displayName?: string;
  bondLevel?: string;
  accounts?: { channel: string; channelUserId: string }[];
  channel?: string;
  channelUserId?: string;
  transferFrom?: string;
  from?: string;
}

interface FetchCall {
  url: string;
  method: string;
  body: WriteBody | undefined;
}

const NOW = Math.floor(Date.now() / 1000);

const GUARDIAN: PersonResource = {
  id: "me",
  displayName: "Zhangfan Dong",
  bondLevel: "guardian",
  accounts: [{ channel: "webchat", channelUserId: "wc-1", displayName: "wc-1" }],
  messageCount: 0,
  latest: null,
  memoryPath: "memory/relationship/GUARDIAN.md",
};

const FRIEND: PersonResource = {
  id: "wei-chen",
  displayName: "Wei Chen",
  bondLevel: "inner-circle",
  accounts: [{ channel: "telegram", channelUserId: "418820113", displayName: "wei_c" }],
  messageCount: 30,
  latest: { source: "telegram", timestamp: NOW - 600, preview: "on my way" },
  memoryPath: "memory/relationship/wei-chen.md",
};

const QUIET_PERSON: PersonResource = {
  id: "nadia",
  displayName: "Nadia Petrova",
  bondLevel: "acquaintance",
  accounts: [],
  messageCount: 0,
  latest: null,
  memoryPath: null,
};

/**
 * One account as the world holds it: the contacts-list row, plus the activity
 * the stream read would project. Neither read answers this shape — `directoryRow`
 * and `streamRow` below cut it down to the one each contract carries.
 */
type WorldAccount = DirectoryAccount & {
  latest: AccountDynamic | null;
  messageCount: number;
};

const directoryRow = ({ latest: _l, messageCount: _c, ...row }: WorldAccount): DirectoryAccount =>
  row;

const streamRow = (account: WorldAccount): StreamAccount | null =>
  account.latest == null
    ? null
    : { ...directoryRow(account), latest: account.latest, messageCount: account.messageCount };

const UNKNOWN_SENDER: WorldAccount = {
  channel: "whatsapp",
  channelUserId: "6591234472@s.whatsapp.net",
  addresses: ["6591234472", "6591234472@s.whatsapp.net"],
  displayName: "Rachel Lim",
  state: "unlinked",
  personId: null,
  personName: null,
  latest: { source: "whatsapp", timestamp: NOW - 7_200, preview: "Are you free Saturday?" },
  messageCount: 12,
};

const SILENT_CONTACT: WorldAccount = {
  channel: "whatsapp",
  channelUserId: "6588021147@s.whatsapp.net",
  addresses: ["6588021147@s.whatsapp.net"],
  displayName: "Jonas Tan",
  state: "unlinked",
  personId: null,
  personName: null,
  latest: null,
  messageCount: 0,
};

const DISMISSED: WorldAccount = {
  channel: "whatsapp",
  channelUserId: "447700900123@s.whatsapp.net",
  addresses: ["447700900123@s.whatsapp.net"],
  displayName: "Crypto signals",
  state: "dismissed",
  personId: null,
  personName: null,
  latest: { source: "whatsapp", timestamp: NOW - 90_000, preview: "100x gains guaranteed" },
  messageCount: 6,
};

const LINKED_ACCOUNT: WorldAccount = {
  channel: "telegram",
  channelUserId: "418820113",
  addresses: ["418820113"],
  displayName: "wei_c",
  state: "linked",
  personId: "wei-chen",
  personName: "Wei Chen",
  latest: { source: "telegram", timestamp: NOW - 600, preview: "on my way" },
  messageCount: 30,
};

/** A LinkedIn sender nobody has placed. LinkedIn had a section of its own on
 *  this page while its threads reached no account read; it has an accounts
 *  address book now, so it arrives here as a sender like any other and is placed by
 *  the same gesture. */
const LINKEDIN_SENDER: WorldAccount = {
  channel: "linkedin",
  channelUserId: "ACoAAArvind01",
  addresses: ["ACoAAArvind01"],
  displayName: "Arvind Srivastav",
  state: "unlinked",
  personId: null,
  personName: null,
  latest: {
    source: "linkedin",
    timestamp: NOW - 3_600,
    preview: "Thursday works. Calendar invite sent.",
  },
  messageCount: 3,
};

const LINKEDIN_PERSON: PersonResource = {
  id: "priya-nair",
  displayName: "Priya Nair",
  bondLevel: "acquaintance",
  accounts: [{ channel: "linkedin", channelUserId: "ACoAAPriya01", displayName: "Priya Nair" }],
  messageCount: 4,
  latest: { source: "linkedin", timestamp: NOW - 900, preview: "sent you a note about the role" },
  memoryPath: null,
};

/** The world both reads are served from, and every write applies to. */
interface World {
  people: PersonResource[];
  accounts: WorldAccount[];
  peopleFail: boolean;
  accountsFail: boolean;
}

type Json = (payload: unknown, status?: number) => Response;

interface AccountRef {
  channel: string;
  channelUserId: string;
}

function findAccount(world: World, ref: AccountRef) {
  return world.accounts.find(
    (account) => account.channel === ref.channel && account.channelUserId === ref.channelUserId,
  );
}

/** Move an account under a person, on both sides of the join. */
function attach(world: World, person: PersonResource, ref: AccountRef) {
  const account = findAccount(world, ref);
  if (!account) return;
  const previous = account.personId && world.people.find((p) => p.id === account.personId);
  if (previous) {
    previous.accounts = previous.accounts.filter(
      (held) => held.channel !== account.channel || held.channelUserId !== account.channelUserId,
    );
  }
  account.state = "linked";
  account.personId = person.id;
  account.personName = person.displayName;
  person.accounts = [
    ...person.accounts,
    {
      channel: account.channel,
      channelUserId: account.channelUserId,
      displayName: account.displayName,
    },
  ];
  person.messageCount += account.messageCount;
  person.latest = account.latest ?? person.latest;
}

/**
 * The write half of the contract, applied to the same world the reads serve.
 *
 * Every verb answers the row it changed and leaves the listing to be read
 * again, which is what lets a test tell a page that settles by refetching from
 * one that patched what it already had.
 */
function applyWrite(
  world: World,
  method: string,
  path: string,
  body: WriteBody,
  json: Json,
): Response {
  const holder = (account: WorldAccount) => ({
    id: account.personId ?? "",
    displayName: account.personName ?? "",
  });

  const decision = /^\/api\/accounts\/([^/]+)\/(.+)\/(dismiss|restore)$/.exec(path);
  if (decision) {
    const [, channel, rawId, verb] = decision;
    const account = findAccount(world, {
      channel: decodeURIComponent(channel ?? ""),
      channelUserId: decodeURIComponent(rawId ?? ""),
    });
    if (!account) return json({ error: "Unknown account" }, 404);
    if (account.state === "linked") return json(linkConflict(account, holder(account)), 409);
    account.state = verb === "dismiss" ? "dismissed" : "unlinked";
    return json(directoryRow(account));
  }

  if (path === "/api/people" && method === "POST") {
    const refs = body.accounts ?? [];
    for (const ref of refs) {
      const held = findAccount(world, ref);
      if (held?.state === "linked") return json(linkConflict(ref, holder(held)), 409);
    }
    const person: PersonResource = {
      id: (body.displayName ?? "").toLowerCase().replace(/\s+/g, "-"),
      displayName: body.displayName ?? "",
      bondLevel: body.bondLevel ?? "other",
      accounts: [],
      messageCount: 0,
      latest: null,
      memoryPath: null,
    };
    world.people.push(person);
    for (const ref of refs) attach(world, person, ref);
    return json(person, 201);
  }

  const link = /^\/api\/people\/([^/]+)\/accounts$/.exec(path);
  if (link && method === "POST") {
    const person = world.people.find((p) => p.id === decodeURIComponent(link[1] ?? ""));
    if (!person) return json({ error: "Unknown person" }, 404);
    const ref = { channel: body.channel ?? "", channelUserId: body.channelUserId ?? "" };
    const held = findAccount(world, ref);
    // Compare-and-swap on the current owner: taking an account from another
    // person needs `transferFrom` naming them exactly.
    if (held?.state === "linked" && held.personId !== person.id) {
      if (body.transferFrom !== held.personId) return json(linkConflict(ref, holder(held)), 409);
    }
    attach(world, person, ref);
    return json(person);
  }

  const merge = /^\/api\/people\/([^/]+)\/merge$/.exec(path);
  if (merge && method === "POST") {
    const into = world.people.find((p) => p.id === decodeURIComponent(merge[1] ?? ""));
    const from = world.people.find((p) => p.id === body.from);
    if (!into || !from) return json({ error: "Unknown person" }, 404);
    for (const ref of [...from.accounts]) attach(world, into, ref);
    world.people = world.people.filter((p) => p.id !== from.id);
    return json(into);
  }

  const one = /^\/api\/people\/([^/]+)$/.exec(path);
  if (one && method === "PATCH") {
    const person = world.people.find((p) => p.id === decodeURIComponent(one[1] ?? ""));
    if (!person) return json({ error: "Unknown person" }, 404);
    if (body.displayName !== undefined) person.displayName = body.displayName;
    if (body.bondLevel !== undefined) person.bondLevel = body.bondLevel;
    return json(person);
  }

  return json({ error: "Unknown route" }, 404);
}

/**
 * Serves both reads from mutable lists, through the same contract helpers the
 * routes are built on — so a fixture cannot drift from them on ordering,
 * filtering, counting or paging, and a write followed by the page's refetch
 * hands back a different world rather than a patched local state.
 */
function mockApi(
  world: { people?: PersonResource[]; accounts?: WorldAccount[] } = {},
  options: {
    limit?: number;
    peopleFail?: boolean;
    accountsFail?: boolean;
    writes?: "fail";
    /** Holds every transfer in flight until this resolves, so a test can act
     *  while one is still running. */
    holdTransfers?: Promise<void>;
  } = {},
) {
  // Cloned rather than shared: the writes below mutate this world, and the
  // fixtures are module constants every other test reads.
  const state: World = {
    people: (world.people ?? []).map((person) => ({ ...person, accounts: [...person.accounts] })),
    accounts: (world.accounts ?? []).map((account) => ({ ...account })),
    peopleFail: options.peopleFail ?? false,
    accountsFail: options.accountsFail ?? false,
  };
  const calls: FetchCall[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = (typeof init?.body === "string" ? JSON.parse(init.body) : undefined) as
      | WriteBody
      | undefined;
    calls.push({ url, method, body });
    const parsed = new URL(url, "http://localhost");
    const params = parsed.searchParams;
    const json: Json = (payload: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => payload }) as Response;

    if (method !== "GET") {
      if (options.writes === "fail") return json({ error: "write refused" }, 500);
      if (body?.transferFrom && options.holdTransfers) await options.holdTransfers;
      return applyWrite(state, method, parsed.pathname, body ?? {}, json);
    }

    // The two account reads over one world: the contacts list, and the recents
    // surface. Which one the page asked for is the view's own answer, so a test
    // that drove the wrong view reads the wrong rows rather than none.
    if (parsed.pathname === "/api/accounts/stream") {
      if (state.accountsFail) return json({ error: "directory unavailable" }, 500);
      return json(
        sliceAccountStream(
          state.accounts.flatMap((account) => streamRow(account) ?? []),
          {
            query: params.get("q"),
            state: parseAccountState(params.get("state")),
            cursor: parseStreamCursor(params.get("cursor")),
            limit: options.limit ?? null,
          },
        ),
      );
    }

    if (url.includes("/api/accounts")) {
      if (state.accountsFail) return json({ error: "directory unavailable" }, 500);
      return json(
        sliceAccountDirectory(state.accounts.map(directoryRow), {
          query: params.get("q"),
          state: parseAccountState(params.get("state")),
          cursor: parseAccountCursor(params.get("cursor")),
          limit: options.limit ?? null,
        }),
      );
    }

    if (url.includes("/api/people")) {
      if (state.peopleFail) return json({ error: "person store unavailable" }, 500);
      // The whole `?q=` match, before `?level=` narrows it: the counts describe
      // that, so every chip's number stays true while another is selected.
      const matching = state.people.filter((person) =>
        personMatchesQuery(person, params.get("q") ?? ""),
      );
      const level = parsePersonFilterLevel(params.get("level"));
      return json({
        people: matching.filter((person) => personMatchesLevel(person, level ?? "all")),
        counts: countPeople(matching),
      });
    }

    return json({});
  }) as typeof fetch);
  return { calls, state };
}

/** The People routes as `App.tsx` declares them, so a test drives the same
 *  redirect, the same two view paths and the same person route the app does —
 *  and a control that navigates is exercised end to end rather than against a
 *  single route that would swallow every address it produced. */
function renderPage(entry = "/people") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/people" element={<PeopleIndexRedirect />} />
          <Route path="/people/latest" element={<PeoplePage view="latest" />} />
          <Route path="/people/directory" element={<PeoplePage view="directory" />} />
          <Route path="/people/person/:personId" element={<div>person page</div>} />
        </Routes>
        <Address />
        <Back />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Reports the address the page is at, for the assertions about what a control
 *  put in it. Rendered inside the router so it sees every navigation. */
function Address() {
  const location = useLocation();
  return (
    <>
      <div data-testid="address">{`${location.pathname}${location.search}`}</div>
      <div data-testid="origin">{(location.state as { from?: string } | null)?.from ?? ""}</div>
    </>
  );
}

/** The browser's back button, which `MemoryRouter` has no chrome for. What it
 *  lands on is the assertion that says which gestures spent a history entry. */
function Back() {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="back" onClick={() => navigate(-1)}>
      back
    </button>
  );
}

function chip(name: RegExp) {
  return screen.getByRole("radio", { name });
}

async function showDirectory(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "Directory" }));
}

describe("PeoplePage stream", () => {
  it("opens on the stream, and reaches a waiting sender through its chip", async () => {
    mockApi({ people: [GUARDIAN, FRIEND], accounts: [UNKNOWN_SENDER] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Wei Chen");
    // A stream row carries the dynamic, not the bond.
    expect(screen.getByText("on my way")).toBeTruthy();

    await user.click(chip(/^Unknown/));
    expect(await screen.findByText("Rachel Lim")).toBeTruthy();
    expect(screen.getByText("Are you free Saturday?")).toBeTruthy();
  });

  it("keeps people with no dynamics out of the stream, and the guardian too", async () => {
    mockApi({ people: [GUARDIAN, FRIEND, QUIET_PERSON] });
    renderPage();

    await screen.findByText("Wei Chen");
    expect(screen.queryByText("Nadia Petrova")).toBeNull();
    expect(screen.queryByText("Zhangfan Dong")).toBeNull();
  });

  it("holds both unplaced ends out of All — each chip is their way in", async () => {
    const user = userEvent.setup();
    mockApi({ people: [GUARDIAN, FRIEND], accounts: [UNKNOWN_SENDER, DISMISSED] });
    renderPage();

    await screen.findByText("Wei Chen");
    expect(screen.queryByText("Rachel Lim")).toBeNull();
    expect(screen.queryByText("Crypto signals")).toBeNull();

    await user.click(chip(/^Unknown/));
    expect(await screen.findByText("Rachel Lim")).toBeTruthy();

    await user.click(chip(/^Stranger/));
    expect(await screen.findByText("Crypto signals")).toBeTruthy();
  });

  it("shows one row per human, never the account beside the person it resolves to", async () => {
    mockApi({ people: [FRIEND], accounts: [LINKED_ACCOUNT] });
    renderPage();

    // Wei Chen's Telegram account is Wei Chen. Two rows would put the bond on
    // one and the history on the other.
    expect(await screen.findByText("Wei Chen")).toBeTruthy();
    expect(screen.queryByText("wei_c")).toBeNull();
  });

  it("counts waiting senders on the Unknown chip, and nowhere else", async () => {
    mockApi({ people: [GUARDIAN, FRIEND], accounts: [UNKNOWN_SENDER, SILENT_CONTACT] });
    renderPage();

    await screen.findByText("Wei Chen");
    // The stream's read is the accounts something has happened on, so its count
    // of unlinked ones is the senders waiting on a decision — a contact nobody
    // has ever heard from is not one, and never reaches this view.
    await waitFor(() => expect(within(chip(/^Unknown/)).getByText("1")).toBeTruthy());
    expect(within(chip(/^All/)).queryByText(/^\d+$/)).toBeNull();
  });

  it("asks each endpoint for the chip's own narrowing rather than filtering a page", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER, DISMISSED] });
    renderPage();

    await screen.findByText("Wei Chen");
    await user.click(chip(/^Stranger/));
    // The directory pages, so a chip that filtered loaded rows would show only
    // the matches that happened to land on page one.
    await waitFor(() => expect(calls.some((c) => c.url.includes("state=dismissed"))).toBe(true));

    await user.click(chip(/^Inner circle/));
    // A bond level is the people read's own parameter.
    await waitFor(() => expect(calls.some((c) => c.url.includes("level=inner-circle"))).toBe(true));
  });

  it("reads no channel mirror for a roster the contract already answers", async () => {
    const { calls } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await screen.findByText("Wei Chen");
    const reads = calls.filter((call) => call.method === "GET").map((call) => call.url);
    expect(reads.filter((url) => url.includes("/api/whatsapp/contacts"))).toEqual([]);
  });

  it("opens a person's dossier from their row", async () => {
    const user = userEvent.setup();
    mockApi({ people: [FRIEND] });
    renderPage();

    await user.click(await screen.findByText("Wei Chen"));
    expect(await screen.findByText("person page")).toBeTruthy();
  });

  it("sends the search term to the server rather than filtering what loaded", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await screen.findByText("Wei Chen");
    await user.type(screen.getByRole("searchbox", { name: /search people/i }), "rachel");

    expect(await screen.findByText("Rachel Lim")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.includes("q=rachel"))).toBe(true));
    // The account read pages, so a filter over the rows that happened to arrive
    // would answer "no such contact" for someone further down the listing.
    expect(screen.queryByText("Wei Chen")).toBeNull();
  });

  it("sends one request for a typed word rather than one per letter", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [FRIEND] });
    renderPage();

    await screen.findByText("Wei Chen");
    await user.type(screen.getByRole("searchbox", { name: /search people/i }), "wei");

    await waitFor(() => expect(calls.some((c) => c.url.includes("q=wei"))).toBe(true));
    // "w" and "we" never reach the wire.
    expect(
      calls.filter((c) => /[?&]q=w(e)?(&|$)/.test(c.url) && c.url.includes("/api/people")),
    ).toHaveLength(0);
  });
});

describe("PeoplePage directory", () => {
  it("groups the roster by bond, with the server's totals on each heading", async () => {
    const user = userEvent.setup();
    mockApi({
      people: [GUARDIAN, FRIEND, QUIET_PERSON],
      accounts: [UNKNOWN_SENDER, SILENT_CONTACT],
    });
    renderPage();

    await screen.findByText("Wei Chen");
    await showDirectory(user);

    // All is the placed roster, the quiet person included — a contacts list
    // answers "who does Rome know", not "who said something". The guardian and
    // the accounts nobody has placed answer other questions, so neither pads it.
    expect(await screen.findByText("Nadia Petrova")).toBeTruthy();
    expect(screen.queryByText("Zhangfan Dong")).toBeNull();
    expect(screen.queryByText("Jonas Tan")).toBeNull();

    await user.click(chip(/^Unknown/));
    // The heading's number is the directory's own, not the rows on screen.
    const unknown = (await screen.findByRole("heading", { name: "Unknown" })).parentElement!;
    expect(within(unknown).getByText("2")).toBeTruthy();
  });

  it("reads the contacts list rather than the stream, and shows no activity in it", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await screen.findByText("Wei Chen");
    expect(screen.getByText("on my way")).toBeTruthy();
    await showDirectory(user);

    const accountReads = () =>
      calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/accounts"));
    await waitFor(() =>
      expect(accountReads().some((c) => !c.url.startsWith("/api/accounts/stream"))).toBe(true),
    );
    // No preview and no count anywhere in the view — the read carries neither.
    await waitFor(() => expect(screen.queryByText("on my way")).toBeNull());
    expect(screen.queryByText("Are you free Saturday?")).toBeNull();
    expect(screen.queryByText(/\d+ messages?/)).toBeNull();
  });

  it("folds the placement gestures into one row menu on an account nobody has decided about", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await screen.findByText("Wei Chen");
    await showDirectory(user);
    await user.click(chip(/^Unknown/));

    // The decision is available wherever the account is, but the roster is for
    // reading: the row wears one quiet control, and the stream's three verbs
    // sit behind it.
    await screen.findByText("Rachel Lim");
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Treat as stranger" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Actions for Rachel Lim" }));
    expect(await screen.findByRole("menuitem", { name: "Create profile…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Link to person…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Treat as stranger" })).toBeTruthy();

    // The menu reaches the same verb the stream's button does: one request
    // creating the person with the account already on it.
    await user.click(screen.getByRole("menuitem", { name: "Create profile…" }));
    await user.click(await screen.findByRole("button", { name: "Create profile" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/people")).toBe(true),
    );
  });

  it("pages the directory by name, resuming at the cursor the server named", async () => {
    const user = userEvent.setup();
    const second: WorldAccount = {
      ...UNKNOWN_SENDER,
      channelUserId: "6580001111@s.whatsapp.net",
      addresses: ["6580001111@s.whatsapp.net"],
      displayName: "Priya Nair",
      latest: { source: "whatsapp", timestamp: NOW - 20_000, preview: "hello!" },
    };
    const { calls } = mockApi({ accounts: [UNKNOWN_SENDER, second] }, { limit: 1 });
    renderPage();

    await showDirectory(user);
    await user.click(chip(/^Unknown/));
    // By name, so Priya comes first however recently Rachel said something.
    expect(await screen.findByText("Priya Nair")).toBeTruthy();
    expect(screen.queryByText("Rachel Lim")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show more" }));

    // Appended, not swapped in: paging is reading further down a listing.
    expect(await screen.findByText("Rachel Lim")).toBeTruthy();
    expect(screen.getByText("Priya Nair")).toBeTruthy();
    expect(calls.some((c) => c.url.includes("cursor="))).toBe(true);
  });

  it("says the roster is empty rather than blaming a search nobody ran", async () => {
    const user = userEvent.setup();
    // A fresh instance: the guardian exists, and nobody has been placed. All
    // holds the guardian back, so the directory is legitimately empty with an
    // empty search box.
    mockApi({ people: [GUARDIAN], accounts: [] });
    renderPage();

    await showDirectory(user);

    expect(await screen.findByText("Nobody here yet")).toBeTruthy();
    expect(screen.queryByText("Nobody matches your search")).toBeNull();
  });

  it("reaches a contact no page has loaded through the search box", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [FRIEND], accounts: [SILENT_CONTACT] });
    renderPage();

    await screen.findByText("Wei Chen");
    await showDirectory(user);
    await user.type(screen.getByRole("searchbox", { name: /search people/i }), "jonas");

    // The contacts list is where a lookup lands: every account is in it, and the
    // term goes to the server rather than filtering whichever page arrived.
    expect(await screen.findByText("Jonas Tan")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.includes("q=jonas"))).toBe(true));
  });
});

describe("PeoplePage placement", () => {
  // The write half of the page, on the /people contract's verbs. What the union
  // page called one "move" decomposes here: placing a sender is a create or a
  // link, dismissing one is a decision about the account, and the ladder's
  // dismissed end has a way back.

  it("places a waiting sender by creating the person and linking the account at once", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ accounts: [UNKNOWN_SENDER] });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(screen.getByRole("button", { name: "Create profile" }));

    const create = await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url === "/api/people");
      expect(call).toBeTruthy();
      return call!;
    });
    // One request, not a create followed by a link: a person created for an
    // account must never exist without it.
    expect(create.body).toMatchObject({
      displayName: "Rachel Lim",
      bondLevel: "acquaintance",
      accounts: [{ channel: "whatsapp", channelUserId: "6591234472@s.whatsapp.net" }],
    });
    // The sender is placed, so it is no longer waiting on a decision.
    await waitFor(() => expect(screen.queryByText("Rachel Lim")).toBeNull());
  });

  it("links a waiting sender onto a person the roster already holds", async () => {
    const user = userEvent.setup();
    const { calls, state } = mockApi({ people: [GUARDIAN, FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await user.click(screen.getByRole("button", { name: "Link" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Wei Chen/ }));
    await user.click(screen.getByRole("button", { name: "Link" }));

    const link = await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/people/wei-chen/accounts");
      expect(call).toBeTruthy();
      return call!;
    });
    expect(link.method).toBe("POST");
    expect(link.body).toEqual({
      channel: "whatsapp",
      channelUserId: "6591234472@s.whatsapp.net",
    });
    expect(state.accounts[0]!.personId).toBe("wei-chen");
  });

  it("confirms a dismissal before writing it, and says so when it fails", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ accounts: [UNKNOWN_SENDER] }, { writes: "fail" });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await user.click(screen.getByRole("button", { name: "Treat as stranger" }));

    // A dismissal changes how Rome answers this sender, so nothing is posted
    // until the confirmation is accepted.
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Rachel Lim");
    expect(calls.some((c) => c.url.includes("/dismiss"))).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Treat as stranger" }));

    // A write that didn't land leaves the account where it was, and says so —
    // closing the dialog silently would read as success.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/dismiss"))).toBe(true);
  });

  it("takes a dismissed sender out of Unknown, and the count that drops is the server's", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ accounts: [UNKNOWN_SENDER, SILENT_CONTACT] });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await waitFor(() => expect(within(chip(/^Unknown/)).getByText("1")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Treat as stranger" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Treat as stranger" }));

    // The row leaves the view because the directory no longer serves it under
    // `state=unlinked`, and the chip loses its number because the directory's
    // own `counts` came back one lower. Neither is a patch of what was cached:
    // the page holds nothing it could have patched.
    await waitFor(() => expect(screen.queryByText("Rachel Lim")).toBeNull());
    expect(within(chip(/^Unknown/)).queryByText(/^\d+$/)).toBeNull();
    const dismiss = calls.find((c) => c.url.includes("/dismiss"))!;
    // Named by the pair the contract names the account with, so every
    // address it answers to travels with it.
    expect(dismiss.url).toBe("/api/accounts/whatsapp/6591234472%40s.whatsapp.net/dismiss");
  });

  it("restores a dismissed sender back onto the ladder", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ accounts: [DISMISSED] });
    renderPage();

    await user.click(chip(/^Stranger/));
    await screen.findByText("Crypto signals");
    await user.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.url === "/api/accounts/whatsapp/447700900123%40s.whatsapp.net/restore",
        ),
      ).toBe(true),
    );
    // Dismissal is a state an account is in, not a merge into a sentinel, so
    // the way back is the same account under the Unknown chip.
    await waitFor(() => expect(screen.queryByText("Crypto signals")).toBeNull());
    await user.click(chip(/^Unknown/));
    expect(await screen.findByText("Crypto signals")).toBeTruthy();
  });

  it("offers a transfer only after naming who holds the account, and only on a second yes", async () => {
    const user = userEvent.setup();
    const { calls, state } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    // Somebody else claimed the account between the read and the click — the
    // race the contract's compare-and-swap exists to catch.
    state.accounts[0]!.state = "linked";
    state.accounts[0]!.personId = "mira";
    state.accounts[0]!.personName = "Mira Chen";

    await user.click(screen.getByRole("button", { name: "Link" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Wei Chen/ }));
    await user.click(screen.getByRole("button", { name: "Link" }));

    // The refusal names the owner rather than reporting a failed write.
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Mira Chen");
    expect(calls.filter((c) => c.url.endsWith("/accounts") && c.body?.transferFrom)).toHaveLength(
      0,
    );

    await user.click(within(dialog).getByRole("button", { name: "Move it here" }));

    await waitFor(() => expect(state.accounts[0]!.personId).toBe("wei-chen"));
    // A transfer re-attributes the account's whole history, so it never happens
    // as the side effect of a retry: the second request is the one that names
    // the person it is taken from.
    expect(calls.filter((c) => c.url === "/api/people/wei-chen/accounts")).toHaveLength(2);
    expect(calls.find((c) => c.body?.transferFrom)?.body).toEqual({
      channel: "whatsapp",
      channelUserId: "6591234472@s.whatsapp.net",
      transferFrom: "mira",
    });
  });

  it("fires one transfer however many times the confirm is clicked", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, state } = mockApi(
      { people: [FRIEND], accounts: [UNKNOWN_SENDER] },
      { holdTransfers: held },
    );
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    state.accounts[0]!.state = "linked";
    state.accounts[0]!.personId = "mira";
    state.accounts[0]!.personName = "Mira Chen";

    await user.click(screen.getByRole("button", { name: "Link" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Wei Chen/ }));
    await user.click(screen.getByRole("button", { name: "Link" }));

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Move it here" });
    await user.click(confirm);
    await user.click(confirm);

    // The dialog stays up until the write settles, so the confirm is still on
    // screen while the first transfer is in flight. A second one would re-attribute
    // the account's history again — and would arrive naming an owner the first
    // has already replaced, so it refuses and reports a conflict against the
    // person the guardian just moved it to.
    expect(calls.filter((call) => call.body?.transferFrom)).toHaveLength(1);

    release();
    await waitFor(() => expect(state.accounts[0]!.personId).toBe("wei-chen"));
  });
});

describe("PeoplePage folds LinkedIn into the general surface", () => {
  it("renders no section of its own for LinkedIn", async () => {
    mockApi({ people: [FRIEND], accounts: [LINKEDIN_SENDER] });
    renderPage();

    await screen.findByText("Wei Chen");
    // The section is gone whole, heading and all — there is no channel-shaped
    // surface below the two views any more.
    expect(screen.queryByText("LinkedIn messages")).toBeNull();
    expect(screen.queryByText("No LinkedIn conversations")).toBeNull();
    // And with it the two abilities only it had: no group thread reaches this
    // page, and nothing on it composes a reply.
    expect(screen.queryByText("Group conversation")).toBeNull();
    expect(screen.queryByPlaceholderText("Reply on LinkedIn")).toBeNull();
    expect(screen.queryByRole("button", { name: "Messages" })).toBeNull();
  });

  it("reads the two contract endpoints for LinkedIn, never a mirror of its own", async () => {
    const { calls } = mockApi({ people: [FRIEND], accounts: [LINKEDIN_SENDER] });
    renderPage();

    await screen.findByText("Wei Chen");
    const reads = calls.filter((call) => call.method === "GET").map((call) => call.url);
    // The same thing already true of WhatsApp: the contract answers the roster,
    // so no channel mirror is read to build it.
    expect(reads.filter((url) => url.includes("/api/linkedin/"))).toEqual([]);
    expect(reads.filter((url) => url.includes("/api/whatsapp/contacts"))).toEqual([]);
  });

  it("streams a LinkedIn sender the way it streams a WhatsApp one", async () => {
    const user = userEvent.setup();
    mockApi({ people: [GUARDIAN, FRIEND], accounts: [UNKNOWN_SENDER, LINKEDIN_SENDER] });
    renderPage();

    await screen.findByText("Wei Chen");
    // Both are senders waiting on a decision, so both sit behind the same chip
    // and are counted by it once each.
    await user.click(chip(/^Unknown/));
    expect(await screen.findByText("Arvind Srivastav")).toBeTruthy();
    expect(screen.getByText("Thursday works. Calendar invite sent.")).toBeTruthy();
    expect(screen.getByText("Rachel Lim")).toBeTruthy();
    // Named by the same channel vocabulary every other channel is named by.
    expect(screen.getByText("LinkedIn")).toBeTruthy();
    await waitFor(() => expect(within(chip(/^Unknown/)).getByText("2")).toBeTruthy());
  });

  it("lists a LinkedIn contact in the directory the way it lists a WhatsApp one", async () => {
    const user = userEvent.setup();
    const WHATSAPP_PERSON: PersonResource = {
      id: "nadia-cross",
      displayName: "Nadia Cross",
      bondLevel: "acquaintance",
      accounts: [
        {
          channel: "whatsapp",
          channelUserId: "6591881123@s.whatsapp.net",
          displayName: "Nadia",
        },
      ],
      messageCount: 8,
      latest: null,
      memoryPath: null,
    };
    mockApi({ people: [GUARDIAN, WHATSAPP_PERSON, LINKEDIN_PERSON] });
    renderPage();

    await screen.findByText("Priya Nair");
    await showDirectory(user);

    // Same heading, same row: name over the identifier the channel recognizes
    // them by, and one row per human either way.
    const acquaintances = (await screen.findByRole("heading", { name: "Acquaintance" }))
      .parentElement!.parentElement!;
    expect(within(acquaintances).getByText("Priya Nair")).toBeTruthy();
    expect(within(acquaintances).getByText("ACoAAPriya01")).toBeTruthy();
    expect(within(acquaintances).getByText("Nadia Cross")).toBeTruthy();
    expect(within(acquaintances).getAllByText("Priya Nair")).toHaveLength(1);
  });

  it("opens a LinkedIn contact's dossier from their row", async () => {
    const user = userEvent.setup();
    mockApi({ people: [LINKEDIN_PERSON] });
    renderPage();

    await user.click(await screen.findByText("Priya Nair"));
    // The person page, not a thread dialog: a LinkedIn conversation is read
    // where every other channel's is.
    expect(await screen.findByText("person page")).toBeTruthy();
  });
});

describe("PeoplePage load failures", () => {
  it("reports a failed read instead of rendering it as an empty roster", async () => {
    mockApi({ people: [FRIEND] }, { peopleFail: true, accountsFail: true });
    renderPage();

    expect(await screen.findByText("Couldn't load")).toBeTruthy();
    expect(screen.queryByText("Nothing new yet")).toBeNull();
  });

  it("retries in place, without a page reload", async () => {
    const user = userEvent.setup();
    const { state } = mockApi({ people: [FRIEND] }, { peopleFail: true, accountsFail: true });
    renderPage();

    await screen.findByText("Couldn't load");
    state.peopleFail = false;
    state.accountsFail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Wei Chen")).toBeTruthy();
    expect(screen.queryByText("Couldn't load")).toBeNull();
  });

  it("keeps a genuinely empty roster on its own empty state", async () => {
    mockApi({});
    renderPage();

    expect(await screen.findByText("Nothing new yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

// Every control on the page is in the address, so each of them is a link to
// share, a state to reload into, and a step the back button can undo.
describe("PeoplePage puts its controls in the address", () => {
  const address = () => screen.getByTestId("address").textContent;
  const searchBox = () => screen.getByRole("searchbox") as HTMLInputElement;
  const checked = (name: string) =>
    screen.getByRole("radio", { name }).getAttribute("aria-checked") === "true";

  it("forwards /people to the stream, keeping the chip and term it arrived with", async () => {
    mockApi({ people: [GUARDIAN, FRIEND] });
    renderPage("/people?level=inner-circle&q=wei");

    await waitFor(() => expect(address()).toBe("/people/latest?level=inner-circle&q=wei"));
  });

  it("opens the view its address names, not the default one", async () => {
    mockApi({ people: [GUARDIAN, FRIEND, QUIET_PERSON] });
    renderPage("/people/directory");

    // The quiet person is a directory row and never a stream one, so their
    // presence is what says which view the address opened.
    expect(await screen.findByText("Nadia Petrova")).toBeTruthy();
    expect(checked("Directory")).toBe(true);
  });

  it("moves the view into the path and the chip into the query", async () => {
    const user = userEvent.setup();
    mockApi({ people: [GUARDIAN, FRIEND] });
    renderPage();

    await screen.findByText("Wei Chen");
    expect(address()).toBe("/people/latest");

    await showDirectory(user);
    await waitFor(() => expect(address()).toBe("/people/directory"));

    await user.click(chip(/^Inner circle/));
    await waitFor(() => expect(address()).toBe("/people/directory?level=inner-circle"));
  });

  it("carries the chip across a view change, and back undoes one choice", async () => {
    const user = userEvent.setup();
    mockApi({ people: [GUARDIAN, FRIEND] });
    renderPage();

    await screen.findByText("Wei Chen");
    await user.click(chip(/^Inner circle/));
    await waitFor(() => expect(address()).toBe("/people/latest?level=inner-circle"));

    await showDirectory(user);
    await waitFor(() => expect(address()).toBe("/people/directory?level=inner-circle"));

    // One deliberate choice, one history entry: back undoes the view change
    // and returns to the stream still on the chip picked before it.
    await user.click(screen.getByTestId("back"));
    await waitFor(() => expect(address()).toBe("/people/latest?level=inner-circle"));
  });

  it("puts the typed term in the address without an entry per letter", async () => {
    const user = userEvent.setup();
    mockApi({ people: [GUARDIAN, FRIEND] });
    renderPage();

    await screen.findByText("Wei Chen");
    await showDirectory(user);
    await user.type(searchBox(), "wei");
    await waitFor(() => expect(address()).toBe("/people/directory?q=wei"));
    expect(searchBox().value).toBe("wei");

    // Three keystrokes replaced the view's entry rather than stacking three on
    // top of it, so one step back is the way out of the directory — not a walk
    // through "we" and "w" to get there.
    await user.click(screen.getByTestId("back"));
    await waitFor(() => expect(address()).toBe("/people/latest"));
  });

  it("opens the box on the term its address names, and searches for it", async () => {
    const { calls } = mockApi({ people: [GUARDIAN, FRIEND, QUIET_PERSON] });
    renderPage("/people/latest?q=nadia");

    await waitFor(() => expect(searchBox().value).toBe("nadia"));
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("/api/people?q=nadia"))).toBe(true),
    );
  });

  it("falls back to every level when the address names one the rail dropped", async () => {
    mockApi({ people: [GUARDIAN, FRIEND] });
    renderPage("/people/latest?level=former-colleague");

    expect(await screen.findByText("Wei Chen")).toBeTruthy();
    expect(checked("All")).toBe(true);
  });
});

// A dossier is opened from a view, and the view it was opened from is what its
// back link owes the guardian. The address travels with the navigation rather
// than being inferred from history, which a merge rewrites.
describe("PeoplePage hands the dossier the view it was opened from", () => {
  it("names the view, the chip and the term the person was reached from", async () => {
    const user = userEvent.setup();
    mockApi({ people: [GUARDIAN, FRIEND, QUIET_PERSON] });
    renderPage("/people/directory?level=inner-circle");

    await user.click(await screen.findByRole("button", { name: /Wei Chen/ }));

    expect(await screen.findByText("person page")).toBeTruthy();
    expect(screen.getByTestId("address").textContent).toBe("/people/person/wei-chen");
    expect(screen.getByTestId("origin").textContent).toBe("/people/directory?level=inner-circle");
  });
});
