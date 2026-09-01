// @rstest-environment jsdom
import { cleanup, screen, render, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { ChannelsSettingsPage } from "./channels-settings-page";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // Radix/jsdom polyfills for the pointer/scroll events Select relies on.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

/**
 * Select renders its options into a portal outside the row, so a choice is
 * "open the trigger, then click the option in the listbox" — the options do
 * not exist in the DOM until the trigger is opened.
 */
async function choose(user: UserEvent, trigger: HTMLElement, optionName: string | RegExp) {
  await user.click(trigger);
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", { name: optionName }));
}

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function ok(json: unknown): Response {
  return { ok: true, status: 200, json: async () => structuredClone(json) } as Response;
}

const defaults = {
  enabled: true,
  activation: {
    mode: "mention",
    botMessages: "ignore",
    whenOthersMentioned: "ignore",
  },
  replies: { placement: "thread" },
  routing: { agentName: null },
  session: { reset: { mode: "idle", idleMinutes: 10_080 } },
};

function item(input: {
  id: string;
  service?: "discord" | "feishu";
  name: string;
  supportedFields?: string[];
  overrides?: object;
}) {
  const service = input.service ?? "discord";
  return {
    availability: "online",
    source: input.overrides ? "configured" : "live",
    snapshot: {
      conversation: {
        ref: { connectionId: `${service}-1`, conversationId: input.id },
        service,
        kind: "channel",
        displayName: input.name,
        containerName: "Rome",
      },
      supportedFields: input.supportedFields ?? [
        "enabled",
        "activation.mode",
        "activation.botMessages",
        "activation.whenOthersMentioned",
        "replies.placement",
        "routing.agentName",
        "session.reset",
      ],
      effective: structuredClone(defaults),
      overrides: input.overrides ?? {},
    },
  };
}

/**
 * Minimal page fixture for the write-path tests: one conversation, no
 * pagination. `failPatch` makes every save reject so the failure path can be
 * driven without a second fetch mock.
 */
function mockApi(options: { failPatch?: boolean; deferFirstPatch?: boolean } = {}) {
  const patchBodies: unknown[] = [];
  const row = item({ id: "engineering", name: "engineering" });
  // Lets a test hold the first PATCH open, edit another field while it is in
  // flight, and only then decide the outcome — the race is scripted, not timed.
  let settleFirst: ((outcome: { fail: boolean }) => void) | null = null;
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url === "/api/connections") return ok({ connections: [] });
    if (url === "/api/agents") return ok({ agents: [] });
    if (url.startsWith("/api/conversation-settings?") && !init?.method) return ok({ items: [row] });
    if (url === "/api/conversation-settings" && init?.method === "PATCH") {
      patchBodies.push(JSON.parse(String(init.body)));
      if (options.deferFirstPatch && patchBodies.length === 1) {
        return new Promise<Response>((resolve, reject) => {
          settleFirst = (outcome) =>
            outcome.fail ? reject(new Error("network down")) : resolve(ok(row.snapshot));
        });
      }
      if (options.failPatch) throw new Error("network down");
      // Echo the write back the way the real API does — a handler that returned
      // the untouched fixture would make the page appear to revert every save.
      const set = JSON.parse(String(init.body)).set as Record<string, unknown>;
      for (const [key, value] of Object.entries(set)) {
        const effective = row.snapshot.effective as Record<string, unknown>;
        effective[key] =
          value && typeof value === "object" ? { ...(effective[key] as object), ...value } : value;
      }
      return ok(row.snapshot);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch);
  return {
    patchBodies,
    failFirstPatch: () => settleFirst?.({ fail: true }),
    resolveFirstPatch: () => settleFirst?.({ fail: false }),
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/settings/channels"]}>
      <ChannelsSettingsPage />
    </MemoryRouter>,
  );
}

async function findCard() {
  const heading = await screen.findByRole("heading", { name: /engineering/ });
  return heading.closest("article") as HTMLElement;
}

/** Comfortably past AUTOSAVE_DEBOUNCE_MS, so "no PATCH" means it was dropped. */
const PAST_DEBOUNCE_MS = 800;

describe("ChannelsSettingsPage", () => {
  it("auto-saves each edit, exposes provider fields and catalog agents, and paginates", async () => {
    const parent = item({
      id: "engineering",
      name: "engineering",
      overrides: { activation: { mode: "mention" } },
    });
    const patchBodies: unknown[] = [];
    const fetchMock = rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/connections") {
        return ok({
          connections: [
            {
              id: "discord-1",
              service: "discord",
              label: "Discord · Rome",
              grants: {},
              display: {},
              capabilities: {
                talk: { state: "unlocked" },
                act: { state: "unsupported" },
                watch: { state: "unsupported" },
              },
              connect: null,
            },
          ],
        });
      }
      if (url === "/api/agents") {
        return ok({ agents: [{ name: "core:main" }, { name: "coding:build" }] });
      }
      if (url.startsWith("/api/conversation-settings?") && !init?.method) {
        return url.includes("cursor=next")
          ? ok({ items: [item({ id: "releases", name: "releases" })] })
          : ok({ items: [parent], nextCursor: "next" });
      }
      if (url === "/api/conversation-settings" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patchBodies.push(body);
        return ok({
          ...parent.snapshot,
          effective: {
            ...defaults,
            enabled: false,
            activation: { ...defaults.activation, mode: "all" },
            routing: { agentName: "coding:build" },
          },
          overrides: {
            enabled: false,
            activation: { mode: "all" },
          },
          updatedAt: "2026-08-03T12:00:00.000Z",
          updatedBy: { kind: "guardian", displayName: "Ray" },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch);

    render(
      <MemoryRouter initialEntries={["/settings/channels?connectionId=discord-1"]}>
        <ChannelsSettingsPage />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const engineeringHeading = await screen.findByRole("heading", { name: /engineering/ });
    const engineeringRow = engineeringHeading.closest("article") as HTMLElement;

    expect(
      fetchMock.mock.calls.some(([request]) => String(request).includes("connectionId=discord-1")),
    ).toBe(true);
    // The fixture overrides exactly one field (activation.mode), so a single
    // marker proves overridden rows are flagged and default rows are not.
    expect(within(engineeringRow).getByText("Overridden")).toBeTruthy();
    // The container prefixes the conversation name so a bare provider-supplied
    // name still reads as a place.
    expect(engineeringHeading.textContent).toBe("Rome / engineering");

    await user.click(
      within(engineeringRow).getByRole("switch", { name: "Rome in this conversation" }),
    );
    await choose(user, within(engineeringRow).getByLabelText(/Respond/), "All");
    // The canonical id comes from /api/agents. Its owner remains visible for
    // disambiguation, while selecting it preserves the runtime value.
    await choose(user, within(engineeringRow).getByLabelText(/Agent/), "build · coding");
    await choose(user, within(engineeringRow).getByLabelText(/Provider session reset/), "Daily");

    // No save button: the edits persist on their own, coalesced into one PATCH
    // because they landed inside a single debounce window.
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toMatchObject({
      ref: { connectionId: "discord-1", conversationId: "engineering" },
      set: {
        enabled: false,
        activation: { mode: "all" },
        routing: { agentName: "coding:build" },
        session: { reset: { mode: "daily", atHour: 4 } },
      },
      clear: [],
    });
    expect(within(engineeringRow).queryByRole("button", { name: /save/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("heading", { name: /releases/ })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([request]) => String(request).includes("cursor=next"))).toBe(
      true,
    );
  });

  it("creates no override when an edit is undone before the debounce elapses", async () => {
    const { patchBodies } = mockApi();
    renderPage();
    const user = userEvent.setup();
    const card = await findCard();
    const toggle = within(card).getByRole("switch", { name: "Rome in this conversation" });

    await user.click(toggle);
    await user.click(toggle);
    await new Promise((resolve) => setTimeout(resolve, PAST_DEBOUNCE_MS));

    // The backend treats any field in `set` as an explicit override, and the UI
    // has no way to clear one — so a value returned to where it started must
    // not reach the wire at all.
    expect(patchBodies).toEqual([]);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("restores the last confirmed value when a save fails", async () => {
    const { patchBodies } = mockApi({ failPatch: true });
    renderPage();
    const user = userEvent.setup();
    const card = await findCard();
    const toggle = within(card).getByRole("switch", { name: "Rome in this conversation" });

    await user.click(toggle);
    await waitFor(() => expect(patchBodies).toHaveLength(1));

    // The card must not keep showing a value the server rejected.
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("sends a queued edit when the page unmounts before the debounce elapses", async () => {
    const { patchBodies } = mockApi();
    const view = renderPage();
    const user = userEvent.setup();
    const card = await findCard();

    await user.click(within(card).getByRole("switch", { name: "Rome in this conversation" }));
    expect(patchBodies).toEqual([]);

    view.unmount();

    await waitFor(() => expect(patchBodies).toHaveLength(1));
  });

  it("keeps a concurrent edit when an unrelated save fails", async () => {
    const { patchBodies, failFirstPatch } = mockApi({ deferFirstPatch: true });
    renderPage();
    const user = userEvent.setup();
    const card = await findCard();

    await user.click(within(card).getByRole("switch", { name: "Rome in this conversation" }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));

    // Second edit lands while the first PATCH is still open, then that one fails.
    await choose(user, within(card).getByLabelText(/Respond/), "All");
    failFirstPatch();

    // Rolling the whole draft back to the confirmed snapshot would wipe this
    // edit, and the next flush would then diff it away as a no-op — losing it
    // from the UI and the server both.
    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toMatchObject({ set: { activation: { mode: "all" } } });
    expect(within(card).getByLabelText(/Respond/).textContent).toContain("All");
  });

  it("sends an edit made while the previous save is still in flight", async () => {
    const { patchBodies, resolveFirstPatch } = mockApi({ deferFirstPatch: true });
    renderPage();
    const user = userEvent.setup();
    const card = await findCard();
    const toggle = within(card).getByRole("switch", { name: "Rome in this conversation" });

    await user.click(toggle);
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toMatchObject({ set: { enabled: false } });

    // Back to the original value while the first PATCH is still open. Diffing
    // against the snapshot would call this a no-op — the snapshot still shows
    // `true` because the response that would have made it `false` has not
    // arrived — and the user's last intent would be silently dropped.
    await user.click(toggle);
    await new Promise((resolve) => setTimeout(resolve, PAST_DEBOUNCE_MS));
    resolveFirstPatch();

    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toMatchObject({ set: { enabled: true } });
  });

  it("shows a retryable error without the empty-state onboarding copy", async () => {
    let settingsLoads = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/connections") return ok({ connections: [] });
      if (url === "/api/agents") return ok({ agents: [] });
      if (url.startsWith("/api/conversation-settings?")) {
        settingsLoads += 1;
        if (settingsLoads === 1) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "Could not load conversations" }),
          } as Response;
        }
        return ok({ items: [] });
      }
      throw new Error(`Unexpected request: GET ${url}`);
    }) as typeof fetch);

    renderPage();
    const user = userEvent.setup();

    expect(await screen.findByText("Could not load conversations")).toBeTruthy();
    expect(screen.queryByText("No configurable conversations found")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No configurable conversations found")).toBeTruthy();
    expect(settingsLoads).toBe(2);
  });
});
