// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimelineEntry } from "@rome/api-types/people";
import {
  countPeople,
  linkConflict,
  sliceAccountDirectory,
  type DirectoryAccount,
  type PersonResource,
} from "@rome/api-types/people";
import i18n from "@/i18n";
import PersonDetailPage, { PersonLegacyRedirect } from "./PersonDetailPage";

// The person page: who they are on top, the merged timeline below. What is under
// test is that the page reads the two routes that own it — `GET /api/people/:id`
// and `GET /api/people/:id/messages` — and that the timeline it renders is
// channel-blind: a Telegram entry renders the way a WhatsApp one does, grouped
// by the calendar day it happened on.

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
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
  accounts: [
    { channel: "whatsapp", channelUserId: "6591881123@s.whatsapp.net", displayName: "Wei" },
    { channel: "telegram", channelUserId: "418820113", displayName: "wei_c" },
  ],
  messageCount: 12,
  latest: { source: "whatsapp", timestamp: NOW - 300, preview: "the landlord replies fast" },
};

const ENTRIES: TimelineEntry[] = [
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
}

interface FetchCall {
  url: string;
  method: string;
  body?: WriteBody;
}

function mockApi(
  options: {
    person?: PersonResource | "missing" | "fail";
    entries?: TimelineEntry[] | "fail";
    nextCursor?: string | null;
    older?: TimelineEntry[];
    people?: PersonResource[];
    accounts?: DirectoryAccount[];
    writes?: "fail";
  } = {},
) {
  const calls: FetchCall[] = [];
  const person = typeof options.person === "object" ? { ...options.person } : { ...PERSON };
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
      return json({
        entries: options.entries ?? ENTRIES,
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
          <Route path="/people/:personId" element={<PersonLegacyRedirect />} />
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
    const older: TimelineEntry = {
      source: "telegram",
      timestamp: NOW - 400_000,
      body: "first hello",
      direction: "inbound",
      ref: "sentinel:1",
    };
    const arrival: TimelineEntry = {
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
    expect(screen.queryByText("Nothing has happened on any channel yet.")).toBeNull();
  });

  it("keeps a genuinely empty history on its own empty state", async () => {
    mockApi({ entries: [] });
    renderPage();

    expect(await screen.findByText("Nothing has happened on any channel yet.")).toBeTruthy();
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
    await user.click(screen.getByRole("combobox", { name: "Bond" }));
    await user.click(await screen.findByRole("option", { name: "Inner circle" }));

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

  it("links an account the directory holds onto this person", async () => {
    const user = userEvent.setup();
    const calls = mockApi({ accounts: [UNPLACED] });
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "Link account…" }));
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
    await user.click(screen.getByRole("button", { name: "Link account…" }));
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
    await user.click(screen.getByRole("button", { name: "Merge into another person…" }));
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
    await user.click(screen.getByRole("combobox", { name: "Bond" }));
    await user.click(await screen.findByRole("option", { name: "Inner circle" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

// A person id is a slug of the guardian's own display name, so `latest` and
// `directory` are ids a guardian can mint. The dossier answers under its own
// segment for that reason, and the address a person was reached by keeps
// working.
describe("PersonDetailPage is reachable whatever the guardian named the person", () => {
  it("opens a person whose id collides with a view name", async () => {
    mockApi({ person: { ...PERSON, id: "latest", displayName: "Latest" } });
    renderPage("latest");

    expect(await screen.findByRole("heading", { name: "Latest" })).toBeTruthy();
  });

  it("forwards the address a person used to be reached by", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApi();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/people/wei-chen"]}>
          <Routes>
            <Route path="/people/latest" element={<div>the stream</div>} />
            <Route path="/people/person/:personId" element={<PersonDetailPage />} />
            <Route path="/people/:personId" element={<PersonLegacyRedirect />} />
          </Routes>
          <Address />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Wei Chen" })).toBeTruthy();
    expect(screen.getByTestId("address").textContent).toBe("/people/person/wei-chen");
  });
});

describe("PersonDetailPage back link survives a merge", () => {
  it("returns to the view it was opened from, not to the person the merge deleted", async () => {
    const user = userEvent.setup();
    mockApi({ people: [DUPLICATE] });
    renderPage("wei-chen", "/people/directory?level=inner-circle");

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "Merge into another person…" }));
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
