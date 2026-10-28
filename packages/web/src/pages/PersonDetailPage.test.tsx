// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Message } from "@rome/api-types/message";
import {
  countPeople,
  linkConflict,
  sliceAccountDirectory,
  type DirectoryAccount,
  type PersonResource,
} from "@rome/api-types/people";
import i18n from "@/i18n";
import PersonDetailPage from "./PersonDetailPage";

// The person page: who they are on top, the merged timeline below. What is under
// test is that the page reads the two routes that own it — `GET /api/people/:id`
// and `GET /api/people/:id/messages` — and that the timeline it renders is
// channel-blind: a Telegram entry renders the way a WhatsApp one does, grouped
// by the calendar day it happened on.

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

// Anchored at noon today rather than at "now": the timeline groups by calendar
// day, so a fixture minutes old is labelled "Yesterday" when the suite happens
// to run just after midnight. Noon is the same day whatever time the run starts.
const NOW = (() => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  return Math.floor(noon.getTime() / 1000);
})();

const PERSON: PersonResource = {
  id: "wei-chen",
  displayName: "Wei Chen",
  bondLevel: "acquaintance",
  // Both sendable, WhatsApp heard from more recently — so `defaultSendAccount`
  // has a preference to express and the composer has one to render.
  accounts: [
    {
      channel: "whatsapp",
      channelUserId: "6591881123@s.whatsapp.net",
      displayName: "Wei",
      send: "yes",
      latestAt: NOW - 300,
    },
    {
      channel: "telegram",
      channelUserId: "418820113",
      displayName: "wei_c",
      send: "yes",
      latestAt: NOW - 90_000,
    },
  ],
  messageCount: 12,
  latest: { source: "whatsapp", timestamp: NOW - 300, preview: "the landlord replies fast" },
  memoryPath: "memory/relationship/wei-chen.md",
};

/** Reachable on one channel Rome mirrors and cannot write to — the composer's
 *  place is taken by the reason instead. */
const READ_ONLY_PERSON: PersonResource = {
  id: "arvind",
  displayName: "Arvind Srivastav",
  bondLevel: "acquaintance",
  accounts: [
    {
      channel: "linkedin",
      channelUserId: "ACoAAB1",
      displayName: "Arvind",
      send: "unsupported",
      latestAt: NOW - 4_000,
    },
  ],
  messageCount: 1,
  latest: null,
  memoryPath: null,
};

const ENTRIES: Message[] = [
  {
    source: "whatsapp",
    timestamp: NOW - 300,
    body: "the landlord replies fast",
    direction: "inbound",
    ref: "wa-1",
  },
  {
    source: "whatsapp",
    timestamp: NOW - 600,
    body: "I will call him this afternoon",
    direction: "outbound",
    ref: "wa-2",
  },
  {
    source: "telegram",
    timestamp: NOW - 90_000,
    body: "dinner was great",
    direction: "inbound",
    ref: "sentinel:7",
  },
];

/** A duplicate of the person, for the merge picker to land on. */
const DUPLICATE: PersonResource = {
  id: "wei-c",
  displayName: "W. Chen",
  bondLevel: "other",
  accounts: [],
  messageCount: 2,
  latest: null,
  memoryPath: null,
};

const UNPLACED: DirectoryAccount = {
  channel: "whatsapp",
  channelUserId: "6591234472@s.whatsapp.net",
  addresses: ["6591234472", "6591234472@s.whatsapp.net"],
  displayName: "Rachel Lim",
  state: "unlinked",
  personId: null,
  personName: null,
};

const HELD_BY_ANOTHER: DirectoryAccount = {
  channel: "telegram",
  channelUserId: "990014422",
  addresses: ["990014422"],
  displayName: "mira_c",
  state: "linked",
  personId: "mira",
  personName: "Mira Chen",
};

/** Whatever a write put on the wire, read back for assertions. */
interface WriteBody {
  displayName?: string;
  bondLevel?: string;
  channel?: string;
  channelUserId?: string;
  transferFrom?: string;
  from?: string;
  text?: string;
}

interface FetchCall {
  url: string;
  method: string;
  body?: WriteBody;
}

function mockApi(
  options: {
    person?: PersonResource | "missing" | "fail";
    entries?: Message[] | "fail";
    nextCursor?: string | null;
    older?: Message[];
    people?: PersonResource[];
    accounts?: DirectoryAccount[];
    writes?: "fail";
    /**
     * How the channel answers a send. `"land"` takes it, and Rome's copy is on
     * the timeline by the next read; `"refuse"` is the 409 a client that raced
     * a disconnect earns; `"fail"` is the channel refusing it, which comes back
     * as a 502 in the channel's words; `"network"` never reaches the server.
     * A test may change it between attempts.
     */
    send?: "land" | "refuse" | "fail" | "network";
    sendWait?: Promise<void>;
    /** `"late"`: a sent message reaches the timeline only on a read after the
     *  one the send settled, as a channel's mirror echo can. */
    echo?: "late";
  } = {},
) {
  const calls: FetchCall[] = [];
  const person = typeof options.person === "object" ? { ...options.person } : { ...PERSON };
  /** What Rome said through the send route, which the timeline read finds. */
  const delivered: Message[] = [];
  /** Sent messages whose echo has not landed yet, each with the timeline reads
   *  still to pass before it does. */
  const echoing: { entry: Message; reads: number }[] = [];
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
    const path = new URL(url, "http://localhost").pathname;
    const json = (payload: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => payload }) as Response;

    if (method === "POST" && path.endsWith("/messages")) {
      await options.sendWait;
      if (options.send === "network") throw new TypeError("Failed to fetch");
      if (options.send === "refuse") {
        return json({ error: "That channel is not connected", send: "not-connected" }, 409);
      }
      if (options.send === "fail") {
        return json({ error: "the channel rejected this message" }, 502);
      }
      const ref = `sent-${delivered.length + echoing.length + 1}`;
      const entry: Message = {
        source: String(body?.channel),
        timestamp: NOW,
        body: String(body?.text),
        direction: "outbound",
        ref,
      };
      if (options.echo === "late") echoing.push({ entry, reads: 1 });
      else delivered.unshift(entry);
      return json({ ref, timestamp: NOW });
    }

    if (method !== "GET") {
      if (options.writes === "fail") return json({ error: "write refused" }, 500);
      if (path.endsWith("/accounts")) {
        const held = (options.accounts ?? []).find(
          (account) =>
            account.channel === body?.channel && account.channelUserId === body?.channelUserId,
        );
        // Compare-and-swap on the current owner: taking an account from another
        // person needs `transferFrom` naming them exactly.
        if (held?.state === "linked" && body?.transferFrom !== held.personId) {
          return json(
            linkConflict(held, { id: held.personId ?? "", displayName: held.personName ?? "" }),
            409,
          );
        }
        return json(person);
      }
      if (path.endsWith("/merge")) {
        const into = (options.people ?? []).find((p) => `/api/people/${p.id}/merge` === path);
        return into ? json(into) : json({ error: "Unknown person" }, 404);
      }
      if (method === "PATCH") {
        if (body?.bondLevel) person.bondLevel = body.bondLevel;
        return json(person);
      }
      return json({ error: "Unknown route" }, 404);
    }

    if (url.includes("/messages")) {
      if (options.entries === "fail") return json({ error: "timeline unavailable" }, 500);
      const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
      if (cursor) return json({ entries: options.older ?? [], nextCursor: null });
      for (const pending of [...echoing]) {
        if (pending.reads-- > 0) continue;
        echoing.splice(echoing.indexOf(pending), 1);
        delivered.unshift(pending.entry);
      }
      return json({
        entries: [...delivered, ...(options.entries ?? ENTRIES)],
        nextCursor: options.nextCursor ?? null,
      });
    }
    if (url.includes("/api/accounts")) {
      return json(sliceAccountDirectory(options.accounts ?? []));
    }
    if (path === "/api/people") {
      const listing = options.people ?? [];
      return json({ people: listing, counts: countPeople(listing) });
    }
    if (url.includes("/api/people/")) {
      if (options.person === "missing") return json({ error: "Unknown person" }, 404);
      if (options.person === "fail") return json({ error: "person store unavailable" }, 500);
      const merged = (options.people ?? []).find((p) => path === `/api/people/${p.id}`);
      return json(merged ?? person);
    }
    return json({});
  }) as typeof fetch);
  return calls;
}

/** The dossier under the People routes `App.tsx` declares, so where its back
 *  link lands is decided by the same history the app gives it. `before` is what
 *  the guardian was looking at when they opened the person — nothing, when the
 *  dossier is the address they arrived on. */
function renderPage(id = "wei-chen", before?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const entries = before
    ? [before, { pathname: `/people/person/${id}`, state: { from: before } }]
    : [`/people/person/${id}`];
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/people/latest" element={<div>the stream</div>} />
          <Route path="/people/directory" element={<div>the directory</div>} />
          <Route path="/people/person/:personId" element={<PersonDetailPage />} />
        </Routes>
        <Address />
        <BrowserBack />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

/** The address the dossier's back link left the guardian on. */
function Address() {
  const location = useLocation();
  return <div data-testid="address">{`${location.pathname}${location.search}`}</div>;
}

/** The browser's Back button. What it reaches after the back link is what says
 *  whether that link consumed the dossier's history entry or stacked another. */
function BrowserBack() {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="browser-back" onClick={() => navigate(-1)}>
      browser back
    </button>
  );
}

describe("PersonDetailPage", () => {
  it("reads the person and their history from the two routes that own them", async () => {
    const calls = mockApi();
    renderPage();

    expect(await screen.findByRole("heading", { name: "Wei Chen" })).toBeTruthy();
    expect(calls.some((call) => call.url.includes("/api/people/wei-chen"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/api/people/wei-chen/messages"))).toBe(true);
    // One request across every account, not one per channel.
    expect(calls.filter((call) => call.url.includes("/messages"))).toHaveLength(1);
  });

  it("renders every account the person is reachable at", async () => {
    mockApi();
    renderPage();

    // The WhatsApp jid renders as the number a guardian would recognize; a
    // channel with no phone shape keeps its own identifier.
    expect(await screen.findByText("+6591881123")).toBeTruthy();
    expect(screen.getByText("418820113")).toBeTruthy();
  });

  it("groups the merged timeline by day, channel-blind", async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText("the landlord replies fast")).toBeTruthy();
    // A Telegram entry renders the way a WhatsApp one does — nothing here knows
    // which store an entry came from.
    expect(screen.getByText("dinner was great")).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Yesterday")).toBeTruthy();
    // Rome's own half of an exchange is marked as such rather than read as the
    // other person's words.
    expect(screen.getByText("You:")).toBeTruthy();
  });

  it("reads a LinkedIn conversation here, the way it reads a WhatsApp one", async () => {
    // The People page carried LinkedIn in a section of its own for as long as
    // its threads resolved to no person. They resolve now, so a LinkedIn
    // conversation is read where every other channel's is: on the person,
    // merged into one history, with no thread dialog and no composer.
    const person: PersonResource = {
      id: "priya-nair",
      displayName: "Priya Nair",
      bondLevel: "acquaintance",
      accounts: [{ channel: "linkedin", channelUserId: "ACoAAPriya01", displayName: "Priya Nair" }],
      messageCount: 2,
      latest: {
        source: "linkedin",
        timestamp: NOW - 300,
        preview: "sent you a note about the role",
      },
      memoryPath: null,
    };
    mockApi({
      person,
      entries: [
        {
          source: "linkedin",
          timestamp: NOW - 300,
          body: "thanks — reading it now",
          direction: "outbound",
          ref: "li-2",
        },
        {
          source: "linkedin",
          timestamp: NOW - 600,
          body: "sent you a note about the role",
          direction: "inbound",
          ref: "li-1",
        },
      ],
    });
    renderPage("priya-nair");

    expect(await screen.findByText("sent you a note about the role")).toBeTruthy();
    expect(screen.getByText("thanks — reading it now")).toBeTruthy();
    expect(screen.getByText("You:")).toBeTruthy();
    expect(screen.getByText("ACoAAPriya01")).toBeTruthy();
    // Read, not write: no channel offers dashboard send from this page.
    expect(screen.queryByPlaceholderText("Reply on LinkedIn")).toBeNull();
  });

  it("pages older entries by the cursor the page it holds ended on", async () => {
    const user = userEvent.setup();
    const calls = mockApi({
      nextCursor: "older-1",
      older: [
        {
          source: "telegram",
          timestamp: NOW - 400_000,
          body: "first hello",
          direction: "inbound",
          ref: "sentinel:1",
        },
      ],
    });
    renderPage();

    await screen.findByText("the landlord replies fast");
    await user.click(screen.getByRole("button", { name: "Load older" }));

    expect(await screen.findByText("first hello")).toBeTruthy();
    // Appended, not swapped in: the head of the history stays above it.
    expect(screen.getByText("the landlord replies fast")).toBeTruthy();
    expect(calls.some((call) => call.url.includes("cursor=older-1"))).toBe(true);
  });

  it("keeps a paged timeline whole when the head is read again", async () => {
    // The reader has paged back through the history and a message arrives, so
    // the head answers something new. What must not happen is the page losing
    // where it had paged to and re-appending the page it already holds: those
    // entries would render twice, under keys React would then see twice.
    // Paging belongs to the query rather than to state kept here, so there is
    // no cursor to snap back — this is that, pinned.
    const older: Message = {
      source: "telegram",
      timestamp: NOW - 400_000,
      body: "first hello",
      direction: "inbound",
      ref: "sentinel:1",
    };
    const arrival: Message = {
      source: "whatsapp",
      timestamp: NOW - 5,
      body: "one more thing",
      direction: "inbound",
      ref: "wa-3",
    };
    let headEntries = ENTRIES;
    const user = userEvent.setup();
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as Response;
      if (url.includes("/messages")) {
        return new URL(url, "http://localhost").searchParams.get("cursor")
          ? json({ entries: [older], nextCursor: null })
          : json({ entries: headEntries, nextCursor: "older-1" });
      }
      return json(PERSON);
    }) as typeof fetch);
    const { queryClient } = renderPage();

    await screen.findByText("the landlord replies fast");
    await user.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText("first hello");

    // A message lands, and the read is refreshed the way its poll refreshes it.
    headEntries = [arrival, ...ENTRIES];
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["person-timeline"] });
    });

    expect(await screen.findByText("one more thing")).toBeTruthy();
    // Every entry once: the page the reader had paged to is still there, and
    // still there only once.
    expect(screen.getAllByText("first hello")).toHaveLength(1);
    expect(screen.getAllByText("the landlord replies fast")).toHaveLength(1);
    // And the history is still exhausted. A page that had forgotten where it
    // paged to would offer to fetch the last page again, which is how the
    // duplicates would arrive.
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("says a person is gone only when the server said so", async () => {
    mockApi({ person: "missing" });
    renderPage("ghost");

    expect(await screen.findByText("That person is not here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers a retry when the read failed rather than claiming they were merged away", async () => {
    mockApi({ person: "fail" });
    renderPage();

    expect(await screen.findByText("Couldn't load")).toBeTruthy();
    expect(screen.queryByText("That person is not here")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("reports a failed timeline instead of an empty history", async () => {
    mockApi({ entries: "fail" });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Wei Chen" })).toBeTruthy();
    expect(await screen.findByText("Couldn't load")).toBeTruthy();
    // "Nothing has happened yet" is a claim about this person, and a failed
    // fetch has not earned it.
    expect(screen.queryByText("Nothing has happened on any account yet.")).toBeNull();
  });

  it("keeps a genuinely empty history on its own empty state", async () => {
    mockApi({ entries: [] });
    renderPage();

    expect(await screen.findByText("Nothing has happened on any account yet.")).toBeTruthy();
  });

  it("goes back to the stream when the dossier is the address the guardian arrived on", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "People" }));

    expect(await screen.findByText("the stream")).toBeTruthy();
  });

  it("returns to the view the person was opened from, on the chip it was on", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage("wei-chen", "/people/directory?level=inner-circle");

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "People" }));

    expect(await screen.findByText("the directory")).toBeTruthy();
    expect(screen.getByTestId("address").textContent).toBe("/people/directory?level=inner-circle");
  });
});

describe("PersonDetailPage management", () => {
  // The write half of the dossier: the bond, the accounts that resolve here,
  // and absorbing a duplicate. Every one of them is a /people verb.

  it("changes the bond with a patch that names only the bond", async () => {
    const user = userEvent.setup();
    const calls = mockApi();
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "Actions for Wei Chen" }));
    await user.click(await screen.findByRole("menuitem", { name: "Change bond" }));
    // Chosen by keyboard: a pointer leaving the submenu's trigger for the item
    // closes the submenu in jsdom, where the pointer has no position to keep
    // it inside the grace area. Enter on the focused item is the same select.
    (await screen.findByRole("menuitemradio", { name: "Inner circle" })).focus();
    await user.keyboard("{Enter}");

    const patch = await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH");
      expect(call).toBeTruthy();
      return call!;
    });
    expect(patch.url).toBe("/api/people/wei-chen");
    // An omitted field is one the update leaves alone, so a bond change must
    // not carry a name and blank it.
    expect(patch.body).toEqual({ bondLevel: "inner-circle" });
  });

  it("opens the memory profile Rome wrote about them, at the address Memory reads it from", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "Actions for Wei Chen" }));

    // A link out to Memory, not a fourth write: the profile is a file, and the
    // editor, the history and the sync state are all on that page.
    const item = await screen.findByRole("menuitem", { name: "Memory profile" });
    expect(item.getAttribute("href")).toBe("/memory/relationship/wei-chen.md");
  });

  it("offers no memory profile for a person nobody has written one about", async () => {
    const user = userEvent.setup();
    // Creating a person writes no profile, so the read answers none — and an
    // item that opened nothing would be on most people's menu.
    mockApi({ person: { ...PERSON, memoryPath: null } });
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "Actions for Wei Chen" }));

    expect(await screen.findByRole("menuitem", { name: "Link account\u2026" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Memory profile" })).toBeNull();
  });

  it("links an account the directory holds onto this person", async () => {
    const user = userEvent.setup();
    const calls = mockApi({ accounts: [UNPLACED] });
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "Actions for Wei Chen" }));
    await user.click(await screen.findByRole("menuitem", { name: "Link account…" }));
    await user.click(await screen.findByRole("button", { name: /Rachel Lim/ }));

    const link = await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/people/wei-chen/accounts");
      expect(call).toBeTruthy();
      return call!;
    });
    expect(link.method).toBe("POST");
    // One call, and it names the account by the pair the contract says is its
    // account — every address it answers to travels with it.
    expect(link.body).toEqual({
      channel: "whatsapp",
      channelUserId: "6591234472@s.whatsapp.net",
    });
  });

  it("names who holds an account, and transfers it only on a second confirmation", async () => {
    const user = userEvent.setup();
    const calls = mockApi({ accounts: [HELD_BY_ANOTHER] });
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "Actions for Wei Chen" }));
    await user.click(await screen.findByRole("menuitem", { name: "Link account…" }));
    await user.click(await screen.findByRole("button", { name: /mira_c/ }));

    // The refusal names the owner rather than reading as a failed write.
    const confirm = await screen.findByRole("dialog", { name: "Move this account?" });
    expect(confirm.textContent).toContain("Mira Chen");
    expect(calls.filter((c) => c.body?.transferFrom)).toHaveLength(0);

    await user.click(within(confirm).getByRole("button", { name: "Move it here" }));

    // A transfer re-attributes the account's whole history, so it is a second
    // request the guardian asked for by name.
    await waitFor(() =>
      expect(calls.find((c) => c.body?.transferFrom)?.body).toEqual({
        channel: "telegram",
        channelUserId: "990014422",
        transferFrom: "mira",
      }),
    );
  });

  it("merges this person into the one picked, and lands on the survivor", async () => {
    const user = userEvent.setup();
    const calls = mockApi({ people: [DUPLICATE] });
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "Actions for Wei Chen" }));
    await user.click(await screen.findByRole("menuitem", { name: "Merge into another person…" }));
    await user.click(await screen.findByRole("button", { name: /W\. Chen/ }));

    const merge = await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith("/merge"));
      expect(call).toBeTruthy();
      return call!;
    });
    // The survivor is named in the path and the duplicate in the body, so the
    // page that had the duplicate open is the one that goes away.
    expect(merge.url).toBe("/api/people/wei-c/merge");
    expect(merge.body).toEqual({ from: "wei-chen" });
    expect(await screen.findByRole("heading", { name: "W. Chen" })).toBeTruthy();
  });

  it("says a refused write failed rather than showing the change as saved", async () => {
    const user = userEvent.setup();
    mockApi({ writes: "fail" });
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "Actions for Wei Chen" }));
    await user.click(await screen.findByRole("menuitem", { name: "Change bond" }));
    // Chosen by keyboard: a pointer leaving the submenu's trigger for the item
    // closes the submenu in jsdom, where the pointer has no position to keep
    // it inside the grace area. Enter on the focused item is the same select.
    (await screen.findByRole("menuitemradio", { name: "Inner circle" })).focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

// A person id is a slug of the guardian's own display name, so `latest` and
// `directory` are ids a guardian can mint. The dossier answers under its own
// segment for that reason.
describe("PersonDetailPage is reachable whatever the guardian named the person", () => {
  it("opens a person whose id collides with a view name", async () => {
    mockApi({ person: { ...PERSON, id: "latest", displayName: "Latest" } });
    renderPage("latest");

    expect(await screen.findByRole("heading", { name: "Latest" })).toBeTruthy();
  });
});

describe("PersonDetailPage back link survives a merge", () => {
  it("returns to the view it was opened from, not to the person the merge deleted", async () => {
    const user = userEvent.setup();
    mockApi({ people: [DUPLICATE] });
    renderPage("wei-chen", "/people/directory?level=inner-circle");

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "Actions for Wei Chen" }));
    await user.click(await screen.findByRole("menuitem", { name: "Merge into another person…" }));
    await user.click(await screen.findByRole("button", { name: /W\. Chen/ }));
    await screen.findByRole("heading", { name: "W. Chen" });

    // The merge deleted Wei Chen, so stepping back through history would land
    // on a dossier that 404s. The survivor carries the origin instead.
    await user.click(screen.getByRole("button", { name: "People" }));

    expect(await screen.findByText("the directory")).toBeTruthy();
    expect(screen.getByTestId("address").textContent).toBe("/people/directory?level=inner-circle");
  });
});

// The back link is an arrow, and an arrow that stacks a third entry lets the
// browser's own Back undo the click that was meant to leave.
describe("PersonDetailPage back link consumes the dossier's history entry", () => {
  it("does not leave the dossier reachable by pressing Back after it", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage("wei-chen", "/people/directory?level=inner-circle");

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "People" }));
    expect(await screen.findByText("the directory")).toBeTruthy();

    await user.click(screen.getByTestId("browser-back"));

    expect(screen.queryByRole("heading", { name: "Wei Chen" })).toBeNull();
    expect(screen.getByTestId("address").textContent).toBe("/people/directory?level=inner-circle");
  });

  it("does not leave a pasted dossier reachable by pressing Back after it", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "People" }));
    expect(await screen.findByText("the stream")).toBeTruthy();

    await user.click(screen.getByTestId("browser-back"));

    expect(screen.queryByRole("heading", { name: "Wei Chen" })).toBeNull();
    expect(screen.getByTestId("address").textContent).toBe("/people/latest");
  });
});

// The composer, the pending sends and the switcher — the half of this page that writes.
//
// What is under test is the one rule the design turns on: Rome never picks a
// recipient out of sight. So the target is on screen before Send is pressed, the
// request carries the account that was on screen, and the view that already
// names an account offers no second choice.
describe("PersonDetailPage, sending", () => {
  it("shows Sending before the request returns and preserves the next draft", async () => {
    const user = userEvent.setup();
    const gate = Promise.withResolvers<void>();
    const calls = mockApi({ send: "land", sendWait: gate.promise });
    renderPage();
    const box = await screen.findByRole("textbox", { name: "Message text" });
    await user.type(box, "on my way");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(box).toHaveProperty("value", "");
    expect(document.activeElement).toBe(box);
    await user.keyboard("{Enter}");
    const pending = screen.getByRole("list", { name: "Not sent" });
    expect(within(pending).getByText("on my way")).toBeTruthy();
    expect(within(pending).getByRole("status").textContent).toBe("Sending");
    expect(within(pending).queryByRole("button")).toBeNull();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

    await user.type(box, "see you soon");
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByRole("list", { name: "Not sent" })).toBeNull());
    expect(screen.getAllByText("on my way")).toHaveLength(1);
    expect(box).toHaveProperty("value", "see you soon");
  });

  it("keeps concurrent sends distinct even when their text is identical", async () => {
    const user = userEvent.setup();
    const gate = Promise.withResolvers<void>();
    const calls = mockApi({ sendWait: gate.promise });
    renderPage();
    const box = await screen.findByRole("textbox", { name: "Message text" });
    await user.type(box, "hello{Enter}");
    await user.type(box, "hello{Enter}");

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    expect(screen.getAllByText("hello")).toHaveLength(2);
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByText("Sending")).toBeNull());
    expect(screen.getAllByText("hello")).toHaveLength(2);
  });

  it("keeps a failed request recoverable without replacing the next draft", async () => {
    const user = userEvent.setup();
    const gate = Promise.withResolvers<void>();
    const options = { send: "network" as "network" | "land", sendWait: gate.promise };
    const calls = mockApi(options);
    renderPage();
    const box = await screen.findByRole("textbox", { name: "Message text" });
    await user.type(box, "on my way{Enter}");
    await user.type(box, "see you soon");
    await act(async () => gate.resolve());

    const pending = screen.getByRole("list", { name: "Not sent" });
    expect(within(pending).getByText("on my way")).toBeTruthy();
    expect(within(pending).getByRole("alert")).toBeTruthy();
    expect(box).toHaveProperty("value", "see you soon");
    options.send = "land";
    await user.click(within(pending).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Not sent" })).toBeNull());
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    expect(box).toHaveProperty("value", "see you soon");
  });

  it("discards a failed local request without writing to the server", async () => {
    const user = userEvent.setup();
    const calls = mockApi({ send: "network" });
    renderPage();
    await user.type(await screen.findByRole("textbox", { name: "Message text" }), "hello{Enter}");
    await user.click(await screen.findByRole("button", { name: "Discard this message" }));
    expect(screen.queryByRole("list", { name: "Not sent" })).toBeNull();
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });

  it("pins the composer so a history longer than the screen scrolls under it", async () => {
    mockApi();
    renderPage();

    // The box is a sticky floor at the bottom of the viewport, so it is on
    // screen at every scroll position instead of only past the last row.
    const box = await screen.findByRole("textbox", { name: "Message text" });
    expect(box.closest(".sticky")).toBeTruthy();
  });

  it("names the account it will send to before anything is typed", async () => {
    mockApi();
    renderPage();

    // The sendable account heard from most recently, which is
    // `defaultSendAccount`'s answer and WhatsApp's here. A default rendered, not
    // a decision taken off screen.
    expect(await screen.findByRole("button", { name: /WhatsApp · \+6591881123/ })).toBeTruthy();
  });

  it("sends from the merged view to the account it showed, and settles both reads", async () => {
    const user = userEvent.setup();
    const calls = mockApi({ send: "land" });
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.type(screen.getByRole("textbox", { name: "Message text" }), "on my way");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const sent = await waitFor(() =>
      calls.find((call) => call.method === "POST" && call.url.endsWith("/messages")),
    );
    // The account is named, always — and it is the one the composer showed.
    expect(sent?.body).toMatchObject({
      channel: "whatsapp",
      channelUserId: "6591881123@s.whatsapp.net",
      text: "on my way",
    });

    // It shows as sending until the channel answers, and then it is on the
    // timeline the send settled.
    await waitFor(
      () => {
        expect(screen.getByText("on my way")).toBeTruthy();
        expect(screen.queryByRole("list", { name: "Not sent" })).toBeNull();
      },
      { timeout: 4000 },
    );
  });

  it("shows a sent message whose channel's copy lands after the send answered", async () => {
    // A channel with a mirror of its own answers for its conversation from the
    // mirror, whose echo can arrive after the read the send settled. The open
    // conversation keeps reading, so the message still shows up.
    const user = userEvent.setup();
    mockApi({ send: "land", echo: "late" });
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.type(screen.getByRole("textbox", { name: "Message text" }), "on my way{Enter}");
    await waitFor(() => expect(screen.queryByRole("list", { name: "Not sent" })).toBeNull());
    expect(screen.queryByText("on my way")).toBeNull();

    expect(await screen.findByText("on my way", {}, { timeout: 8_000 })).toBeTruthy();
  }, 15_000);

  it("offers no picker inside an account view, because the view is the target", async () => {
    const user = userEvent.setup();
    const calls = mockApi({ send: "land" });
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("radio", { name: "Telegram" }));

    // The trigger that changes the target is gone; the target itself is still
    // stated. Asking the guardian to choose again inside a view named after one
    // account is asking twice.
    expect(screen.queryByRole("button", { name: /WhatsApp · / })).toBeNull();
    expect(screen.getByText(/Telegram · 418820113/)).toBeTruthy();

    await user.type(screen.getByRole("textbox", { name: "Message text" }), "see you there");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const sent = await waitFor(() =>
      calls.find((call) => call.method === "POST" && call.url.endsWith("/messages")),
    );
    expect(sent?.body).toMatchObject({ channel: "telegram", channelUserId: "418820113" });
  });

  it("keeps a refused send with the channel's words, and sends it again on Retry", async () => {
    const user = userEvent.setup();
    const options: { send: "fail" | "land" } = { send: "fail" };
    const calls = mockApi(options);
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.type(screen.getByRole("textbox", { name: "Message text" }), "are you there");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // A refused send stays until the guardian acts on it. Rome kept no record
    // of it, so this page is the only place it can be tried again.
    const pending = await screen.findByRole("list", { name: "Not sent" });
    expect(within(pending).getByText("are you there")).toBeTruthy();
    expect(within(pending).getByText("the channel rejected this message")).toBeTruthy();

    options.send = "land";
    await user.click(within(pending).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Not sent" })).toBeNull());
    const posts = calls.filter((call) => call.method === "POST" && call.url.endsWith("/messages"));
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    expect(await screen.findByText("are you there")).toBeTruthy();
  });

  it("keeps a refused message under its original account when the target changes", async () => {
    const user = userEvent.setup();
    mockApi({ send: "refuse" });
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.type(screen.getByRole("textbox", { name: "Message text" }), "on my way");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The 409 renders as the line the composer would have shown had the read
    // been fresh — WhatsApp's, because WhatsApp is the target.
    const refusal = await screen.findByText(
      "WhatsApp isn't connected, so Rome can't send there. Connect it in Settings.",
    );
    expect(refusal).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /WhatsApp · / }));
    await user.click(await screen.findByRole("menuitem", { name: /Telegram/ }));
    expect(screen.getByText(/Telegram · 418820113/)).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Not sent" })).getByText("on my way"),
    ).toBeTruthy();
    expect(refusal).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Telegram" }));
    expect(screen.queryByRole("list", { name: "Not sent" })).toBeNull();
  });

  it("replaces the composer with the reason when the account cannot be written to", async () => {
    mockApi({ person: READ_ONLY_PERSON });
    renderPage("arvind");

    await screen.findByRole("heading", { name: "Arvind Srivastav" });
    expect(screen.getByText("Rome cannot send on LinkedIn yet.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message text" })).toBeNull();
    // And the history stays readable.
    expect(await screen.findByText("the landlord replies fast")).toBeTruthy();
  });
});
