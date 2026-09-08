// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import RoutinesPage from "./RoutinesPage";
import type { ActionCatalogEntry } from "@/hooks/use-action-catalog";
import type { Routine, RoutineRun } from "@/lib/routine-language";

// The /routines page is a read-and-control surface: every guardian-facing line
// is derived from mechanism, and On/Off writes go through PATCH then re-read
// server truth. These tests drive the rendered page against a tiny stateful fake
// backend and assert on the plain-language text a guardian would see — not on
// internals — so they survive refactors and pin the actual contract.

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  rs.useRealTimers();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
});

function scheduleRoutine(overrides: Partial<Routine> & Pick<Routine, "id" | "name">): Routine {
  return {
    enabled: true,
    trigger: { type: "schedule", tzid: "UTC", localTime: "09:00", rrule: "FREQ=DAILY" },
    actionName: "send_message",
    args: {},
    createdAt: new Date("2026-06-01T00:00:00Z").toISOString(),
    lastFiredAt: null,
    nextRunAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    ...overrides,
  };
}

function eventRoutine(overrides: Partial<Routine> & Pick<Routine, "id" | "name">): Routine {
  return {
    enabled: true,
    trigger: { type: "event-bus", eventName: "order.created" },
    actionName: "send_message",
    args: {},
    createdAt: new Date("2026-06-01T00:00:00Z").toISOString(),
    lastFiredAt: new Date(Date.now() - 86_400_000).toISOString(),
    nextRunAt: null,
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

// Mutable server state: a PATCH flips `enabled` in place so the next GET reflects
// the new truth — exactly what an invalidate-and-refetch sees. Run lists are
// keyed by routine id and default to empty.
function mockBackend(initial: {
  routines: Routine[];
  runs?: Record<string, RoutineRun[]>;
  actions?: ActionCatalogEntry[];
  // Outcome the POST /run endpoint reports back (mirrors a real run's status).
  runOutcome?: { status: string; error?: string };
  // Endpoints the network never reaches — the guardian's side of an outage.
  unreachable?: { list?: boolean; run?: boolean };
  // Holds the action catalog response until resolved, so the in-flight window is
  // observable instead of instantaneous.
  actionsGate?: Promise<unknown>;
}) {
  const routines = initial.routines.map((r) => ({ ...r }));
  const runs = initial.runs ?? {};
  const runOutcome = initial.runOutcome ?? { status: "success" };
  const unreachable = initial.unreachable ?? {};
  const calls: FetchCall[] = [];

  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });

    const ok = (json: unknown) =>
      ({ ok: true, status: 200, json: async () => structuredClone(json) }) as Response;

    if (url === "/api/routines" && method === "GET") {
      if (unreachable.list) throw new TypeError("Failed to fetch");
      return ok(routines);
    }
    if (url === "/api/actions" && method === "GET") {
      if (initial.actionsGate) await initial.actionsGate;
      return ok({ actions: initial.actions ?? [] });
    }
    const runsMatch = url.match(/^\/api\/routines\/([^/]+)\/runs/);
    if (runsMatch && method === "GET") {
      const id = decodeURIComponent(runsMatch[1]);
      return ok(runs[id] ?? []);
    }
    const cancelMatch = url.match(/^\/api\/routines\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "POST") {
      // Mirror the backend: the active run is forced to "cancelled", so the next
      // GET no longer reports the routine as running.
      const id = decodeURIComponent(cancelMatch[1]);
      const r = routines.find((x) => x.id === id);
      if (r) r.lastRun = { status: "cancelled", firedAt: new Date().toISOString() };
      return ok({ stopped: true, killedLiveProcess: false });
    }
    const runNowMatch = url.match(/^\/api\/routines\/([^/]+)\/run$/);
    if (runNowMatch && method === "POST") {
      if (unreachable.run) throw new TypeError("Failed to fetch");
      // Mirror the real backend: the run is recorded, so the next GET reflects
      // it as the routine's latest run (drives the status badge).
      const id = decodeURIComponent(runNowMatch[1]);
      const r = routines.find((x) => x.id === id);
      if (r) {
        r.lastRun = {
          status: runOutcome.status as RoutineRun["status"],
          firedAt: new Date().toISOString(),
        };
      }
      return ok({ runId: "run-now-1", ...runOutcome });
    }
    const idMatch = url.match(/^\/api\/routines\/([^/?]+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      if (method === "PATCH") {
        const r = routines.find((x) => x.id === id);
        if (r && typeof body?.enabled === "boolean") r.enabled = body.enabled;
        return ok({ ok: true });
      }
      if (method === "DELETE") {
        const idx = routines.findIndex((x) => x.id === id);
        if (idx >= 0) routines.splice(idx, 1);
        return ok({ ok: true });
      }
    }
    return ok({});
  }) as typeof fetch);

  return calls;
}

// Stand-in for the detail route so a row click's navigation is observable.
function DetailProbe() {
  const { id } = useParams();
  return <div>detail-view:{id}</div>;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/routines"]}>
        <Routes>
          <Route path="/routines" element={<RoutinesPage />} />
          <Route path="/routines/:id" element={<DetailProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RoutinesPage", () => {
  it("groups schedule routines under On a schedule and event routines under When something happens", async () => {
    mockBackend({
      routines: [
        scheduleRoutine({ id: "s1", name: "Morning tidy" }),
        eventRoutine({ id: "e1", name: "Order alert" }),
      ],
    });
    renderPage();

    expect(await screen.findByText("On a schedule")).toBeTruthy();
    expect(screen.getByText("When something happens")).toBeTruthy();
  });

  it("renders a derived behavior sentence for a weekday-9am routine", async () => {
    const browserTzid = Intl.DateTimeFormat().resolvedOptions().timeZone;
    mockBackend({
      routines: [
        scheduleRoutine({
          id: "s1",
          name: "Inbox",
          trigger: {
            type: "schedule",
            tzid: browserTzid,
            localTime: "09:00",
            rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
          },
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText("Every weekday at 9:00 AM")).toBeTruthy();
  });

  it("headlines the card with the guardian's name and keeps the mechanism line beneath", async () => {
    const browserTzid = Intl.DateTimeFormat().resolvedOptions().timeZone;
    mockBackend({
      routines: [
        // Disabled so the StatsBar "next up" section doesn't also render the
        // name/action — keeping these assertions scoped to the card itself.
        scheduleRoutine({
          id: "s1",
          name: "GitHub Trending digest",
          actionName: "summon",
          args: { prompt: "scrape trending and email me" },
          enabled: false,
          trigger: { type: "schedule", tzid: browserTzid, localTime: "08:00", rrule: "FREQ=DAILY" },
        }),
      ],
    });
    renderPage();

    // The user's name is the headline...
    expect(await screen.findByText("GitHub Trending digest")).toBeTruthy();
    // ...and the derived cadence shows on the subline beneath it.
    expect(screen.getByText("Every day at 8:00 AM")).toBeTruthy();
  });

  it("falls back to the mechanism line when the name is just the action name", async () => {
    const browserTzid = Intl.DateTimeFormat().resolvedOptions().timeZone;
    mockBackend({
      routines: [
        // Disabled to keep the raw action name out of the StatsBar next-up line.
        scheduleRoutine({
          id: "s1",
          name: "sentinel_review",
          actionName: "sentinel_review",
          enabled: false,
          trigger: {
            type: "schedule",
            tzid: browserTzid,
            localTime: "00:00",
            rrule: "FREQ=HOURLY;INTERVAL=2",
          },
        }),
      ],
    });
    renderPage();

    // The humanized action phrase becomes the (capitalized) headline...
    expect(await screen.findByText("Sentinel review")).toBeTruthy();
    // ...but the raw machine name is never surfaced.
    expect(screen.queryByText("sentinel_review")).toBeNull();
  });

  it("renders a derived Whenever sentence for an event routine", async () => {
    mockBackend({
      routines: [
        eventRoutine({
          id: "e1",
          name: "Orders",
          trigger: { type: "event-bus", eventName: "order.created" },
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText("Whenever a new order comes in")).toBeTruthy();
  });

  it("keeps run state off the event card and navigates to its detail view on click", async () => {
    mockBackend({
      routines: [eventRoutine({ id: "e1", name: "Orders", lastFiredAt: null })],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    // The card itself carries no waiting/last-ran/run-count line.
    expect(await screen.findByText("Whenever a new order comes in")).toBeTruthy();
    expect(screen.queryByText(/Waiting/)).toBeNull();
    expect(screen.queryByText(/hasn't run yet/)).toBeNull();

    // The left zone is a text-only link that opens the detail view.
    await user.click(screen.getByRole("link", { name: "Orders" }));
    expect(await screen.findByText("detail-view:e1")).toBeTruthy();
  });

  it("shows the next run time only on enabled schedule cards", async () => {
    mockBackend({
      routines: [
        scheduleRoutine({ id: "s1", name: "On", enabled: true }),
        scheduleRoutine({ id: "s2", name: "Off", enabled: false }),
      ],
    });
    renderPage();

    // The subline appends "· next run in <value>" only when a future run exists.
    expect(await screen.findByText(/next run in/)).toBeTruthy();
    // Only the enabled card shows an upcoming run; the disabled one shows just
    // its cadence, with no next-run clause.
    expect(screen.getAllByText(/next run/).length).toBe(1);
  });

  it("tells the guardian when they have no routines", async () => {
    mockBackend({ routines: [] });
    renderPage();

    expect(await screen.findByText("No routines")).toBeTruthy();
  });

  it("toggling Off calls PATCH enabled:false and reflects Off", async () => {
    const calls = mockBackend({
      routines: [scheduleRoutine({ id: "s1", name: "Morning tidy", enabled: true })],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    const toggle = await screen.findByRole("switch", { name: /Morning tidy/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await user.click(toggle);

    await waitFor(() => {
      const patch = calls.find((c) => c.url.endsWith("/api/routines/s1") && c.method === "PATCH");
      expect(patch?.body).toEqual({ enabled: false });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: /Morning tidy/ }).getAttribute("aria-checked"),
      ).toBe("false"),
    );
  });

  it("Run now POSTs to /run", async () => {
    const calls = mockBackend({
      routines: [scheduleRoutine({ id: "s1", name: "Morning tidy" })],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: /Run Morning tidy now/ }));

    await waitFor(() => {
      const run = calls.find((c) => c.url.endsWith("/api/routines/s1/run") && c.method === "POST");
      expect(run).toBeTruthy();
    });
  });

  it("a running routine shows Stop, and stopping it restores Run now", async () => {
    const calls = mockBackend({
      routines: [
        scheduleRoutine({
          id: "s1",
          name: "Long job",
          lastRun: { status: "running", firedAt: new Date().toISOString() },
        }),
      ],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    // Running → a Stop control replaces Run now.
    const stopBtn = await screen.findByRole("button", { name: /Stop Long job/ });
    expect(screen.queryByRole("button", { name: /Run Long job now/ })).toBeNull();

    await user.click(stopBtn);

    await waitFor(() => {
      const cancel = calls.find(
        (c) => c.url.endsWith("/api/routines/s1/cancel") && c.method === "POST",
      );
      expect(cancel).toBeTruthy();
    });
    // After the refetch the stuck running state is gone — Run now returns.
    expect(await screen.findByRole("button", { name: /Run Long job now/ })).toBeTruthy();
  });

  it("offers Run now (not Stop) for a routine awaiting approval", async () => {
    // A pending_approval run has no live process to kill — Stop can't truly stop
    // it, so the card keeps the Run now control instead of a dead Stop button.
    mockBackend({
      routines: [
        scheduleRoutine({
          id: "s1",
          name: "Needs approval",
          lastRun: { status: "pending_approval", firedAt: new Date().toISOString() },
        }),
      ],
    });
    renderPage();

    expect(await screen.findByRole("button", { name: /Run Needs approval now/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stop Needs approval/ })).toBeNull();
  });

  it("surfaces a failing count and filters the list to the failing routines when clicked", async () => {
    mockBackend({
      routines: [
        // Errored last run → counts as failing. Scheduled far out so it isn't the
        // next-up routine (keeps the name out of the panel's next-up line).
        scheduleRoutine({
          id: "s1",
          name: "Inventory sync",
          nextRunAt: new Date(Date.now() + 10 * 3_600_000).toISOString(),
          lastRun: { status: "error", firedAt: new Date().toISOString() },
        }),
        scheduleRoutine({
          id: "s2",
          name: "Morning tidy",
          nextRunAt: new Date(Date.now() + 11 * 3_600_000).toISOString(),
        }),
        // Soonest run → owns the next-up line, so its name never collides with the
        // two cards we assert on.
        scheduleRoutine({
          id: "s3",
          name: "Heartbeat",
          nextRunAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    // The stat panel shows a clickable Failing cell counting the one errored run.
    const failingCell = await screen.findByRole("button", { name: "Show 1 failing routines" });
    // All three are listed before filtering.
    expect(screen.getByText("Morning tidy")).toBeTruthy();

    await user.click(failingCell);

    // After the click only the failing routine remains in the list.
    await waitFor(() => expect(screen.queryByText("Morning tidy")).toBeNull());
    expect(screen.getByText("Inventory sync")).toBeTruthy();
  });

  it("shows no health indicator at all when nothing is failing", async () => {
    mockBackend({
      routines: [scheduleRoutine({ id: "s1", name: "Morning tidy" })],
    });
    renderPage();

    // The page has loaded (the title is up)...
    expect(await screen.findByRole("heading", { name: "Routines" })).toBeTruthy();
    // ...but a confirmed-healthy state carries no pill — nothing to click.
    expect(screen.queryByRole("button", { name: /failing routines/ })).toBeNull();
  });

  it("deletes a routine after the guardian confirms removal", async () => {
    const calls = mockBackend({
      routines: [scheduleRoutine({ id: "s1", name: "Morning tidy" })],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Routine options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => {
      const del = calls.find((c) => c.url.endsWith("/api/routines/s1") && c.method === "DELETE");
      expect(del).toBeTruthy();
    });
    await waitFor(() => expect(screen.queryByRole("switch", { name: /Morning tidy/ })).toBeNull());
  });

  it("moves a completed one-off into a collapsed Done section and marks it done", async () => {
    mockBackend({
      routines: [
        // A consumed one-off: the trigger fired (lastFiredAt set — only real
        // fires set it), so the scheduler disabled it and cleared nextRunAt.
        scheduleRoutine({
          id: "s1",
          name: "Ship the report",
          enabled: false,
          trigger: { type: "schedule", tzid: "UTC", localTime: "09:00", date: "2026-07-20" },
          lastFiredAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          nextRunAt: null,
          lastRun: {
            status: "success",
            firedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          },
        }),
        scheduleRoutine({ id: "s2", name: "Morning tidy" }),
      ],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    // The live schedule section is up, but the completed one-off is not in it —
    // the Done section starts collapsed with only its header and count showing.
    expect(await screen.findByText("On a schedule")).toBeTruthy();
    expect(screen.queryByText("Ship the report")).toBeNull();
    const doneToggle = screen.getByRole("button", { name: /Done/ });
    expect(doneToggle.getAttribute("aria-expanded")).toBe("false");

    await user.click(doneToggle);

    // Expanded: the completed task appears, marked with a Done badge.
    expect(await screen.findByText("Ship the report")).toBeTruthy();
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("One-time routines that already ran.")).toBeTruthy();
  });

  it("keeps an unfired one-off in the schedule section with no Done section", async () => {
    mockBackend({
      routines: [
        // Still pending: dated one-off that has not fired yet.
        scheduleRoutine({
          id: "s1",
          name: "Ship the report",
          trigger: { type: "schedule", tzid: "UTC", localTime: "09:00", date: "2027-01-01" },
        }),
      ],
    });
    renderPage();

    // The name shows on the card (and the stats panel's next-up line).
    expect((await screen.findAllByText("Ship the report")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("On a schedule")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Done/ })).toBeNull();
  });

  it("keeps a currently-running one-off in the live section until it finishes", async () => {
    mockBackend({
      routines: [
        // The trigger fired but the run is still in flight — the card stays live
        // (with its Stop control) rather than reading as already done.
        scheduleRoutine({
          id: "s1",
          name: "Long export",
          trigger: { type: "schedule", tzid: "UTC", localTime: "09:00", date: "2026-07-23" },
          lastFiredAt: new Date().toISOString(),
          nextRunAt: null,
          lastRun: { status: "running", firedAt: new Date().toISOString() },
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText("On a schedule")).toBeTruthy();
    expect(screen.getByText("Long export")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Done/ })).toBeNull();
  });

  it("defaults a new one-off to today and three minutes from now", async () => {
    rs.useFakeTimers({ toFake: ["Date"] });
    rs.setSystemTime(new Date(2026, 6, 29, 10, 14));
    mockBackend({ routines: [] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Create Routine" }));

    expect(document.querySelector<HTMLInputElement>("#routine-localtime")?.value).toBe("10:17");
    expect(document.querySelector<HTMLButtonElement>("#routine-startdate")?.textContent).toContain(
      "July 29th, 2026",
    );
  });

  it("caps a near-midnight one-off at 11:59 PM today", async () => {
    rs.useFakeTimers({ toFake: ["Date"] });
    rs.setSystemTime(new Date(2026, 6, 29, 23, 58));
    mockBackend({ routines: [] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Create Routine" }));

    expect(document.querySelector<HTMLInputElement>("#routine-localtime")?.value).toBe("23:59");
    expect(document.querySelector<HTMLButtonElement>("#routine-startdate")?.textContent).toContain(
      "July 29th, 2026",
    );
  });

  it("allows wheel scrolling in the action picker inside the create dialog", async () => {
    rs.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    mockBackend({
      routines: [],
      actions: Array.from({ length: 12 }, (_, index) => ({
        name: `action_${index}`,
        description: `Action ${index}`,
        type: "system",
        sideEffects: "read-only",
        requiresApproval: false,
        ownerType: "system",
        ownerId: "system",
        inputSchema: null,
      })),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Create Routine" }));
    const actionPicker = await waitFor(() => {
      const element = document.querySelector<HTMLButtonElement>("#routine-actionname");
      expect(element).toBeTruthy();
      return element as HTMLButtonElement;
    });
    await user.click(actionPicker);

    const actionList = await screen.findByRole("listbox");
    actionList.style.overflowY = "auto";
    Object.defineProperties(actionList, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 800 },
    });

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });
    actionList.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(false);
  });

  it("reports a failed list load instead of rendering it as an empty list", async () => {
    const calls = mockBackend({
      routines: [scheduleRoutine({ id: "s1", name: "Morning tidy" })],
      unreachable: { list: true },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    expect(await screen.findByText("Failed to load routines")).toBeTruthy();
    // The success layout never paints: no "you have none" line, no zeroed stats.
    expect(screen.queryByText("No routines")).toBeNull();
    expect(screen.queryByText("Total")).toBeNull();

    const before = calls.filter((c) => c.url === "/api/routines" && c.method === "GET").length;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === "/api/routines" && c.method === "GET").length,
      ).toBeGreaterThan(before),
    );
  });

  it("names an agent-created routine the same way in Timeline as in the list", async () => {
    mockBackend({
      routines: [
        scheduleRoutine({
          id: "s1",
          name: "sentinel_review",
          actionName: "sentinel_review",
          enabled: false,
        }),
      ],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    // The list view humanizes the machine name...
    expect(await screen.findByText("Sentinel review")).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: "Timeline" }));

    // ...and Timeline headlines the same routine identically.
    expect(await screen.findByRole("heading", { name: "Sentinel review" })).toBeTruthy();
  });

  it("asks for the same confirmation before deleting from Timeline as from the list", async () => {
    const calls = mockBackend({ routines: [scheduleRoutine({ id: "s1", name: "Morning tidy" })] });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(await screen.findByRole("radio", { name: "Timeline" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    // Nothing is destroyed on the first click.
    expect(await screen.findByText("Delete this routine?")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      const del = calls.find((c) => c.url.endsWith("/api/routines/s1") && c.method === "DELETE");
      expect(del).toBeTruthy();
    });
  });

  it("tells the guardian when Run now never reached the server", async () => {
    mockBackend({
      routines: [scheduleRoutine({ id: "s1", name: "Morning tidy" })],
      unreachable: { run: true },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: /Run Morning tidy now/ }));

    expect(await screen.findByText("Failed to run routine")).toBeTruthy();
  });

  it("shows the action field as loading while the catalog is in flight, not as unavailable", async () => {
    let releaseCatalog!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    mockBackend({
      routines: [],
      actionsGate: gate,
      actions: [
        {
          name: "send_message",
          description: "Send a message",
          type: "system",
          sideEffects: "write",
          requiresApproval: false,
          ownerType: "system",
          ownerId: "system",
          inputSchema: null,
        },
      ],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Create Routine" }));

    // In flight: an explicit loading control, not the degraded free-text fallback.
    const loadingControl = await screen.findByLabelText("Action Name");
    expect(loadingControl.textContent).toContain("Loading actions…");
    expect(screen.queryByPlaceholderText("send_reminder")).toBeNull();

    releaseCatalog();

    await waitFor(() =>
      expect(screen.getByLabelText("Action Name").textContent).toContain("Pick an action…"),
    );
  });

  it("calls the default view List and calls a switched-off routine Paused everywhere", async () => {
    mockBackend({
      routines: [scheduleRoutine({ id: "s1", name: "Morning tidy", enabled: false })],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    // The segment promising a dense table is now named for what it renders.
    expect(await screen.findByRole("radio", { name: "List" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Table" })).toBeNull();

    // The stat cell and the filter beside it use one word for `!enabled`.
    expect(screen.getByText("Paused")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /All routines/ }));
    expect(await screen.findByRole("menuitem", { name: "Paused" })).toBeTruthy();
  });

  it("labels each calendar dot with its recurrence and legends both hues", async () => {
    // Mid-month so both routines land on a day the current month always has.
    const midMonth = new Date();
    midMonth.setDate(15);
    midMonth.setHours(12, 0, 0, 0);
    mockBackend({
      routines: [
        scheduleRoutine({ id: "s1", name: "Daily digest", nextRunAt: midMonth.toISOString() }),
        scheduleRoutine({
          id: "s2",
          name: "Ship the report",
          trigger: { type: "schedule", tzid: "UTC", localTime: "09:00", date: "2026-07-15" },
          nextRunAt: midMonth.toISOString(),
        }),
      ],
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(await screen.findByRole("radio", { name: "Calendar" }));

    // Hue is not the only channel: each dot carries its recurrence as a label...
    expect((await screen.findAllByLabelText("recurring")).length).toBe(1);
    expect(screen.getAllByLabelText("one-time").length).toBe(1);
    // ...and a legend spells both out as visible text.
    expect(screen.getByText("recurring")).toBeTruthy();
    expect(screen.getByText("one-time")).toBeTruthy();
  });
});
