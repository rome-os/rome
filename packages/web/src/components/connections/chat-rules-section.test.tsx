// @rstest-environment jsdom
import { cleanup, screen, render, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { ChatRulesSection } from "./chat-rules-section";
import { linkOf } from "@/test/account-links";

beforeAll(async () => {
  await i18n.changeLanguage("en");
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
        ref: { connectionId: `${service}-1`, chatId: input.id },
        connectionKind: service,
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
    if (url.startsWith("/api/chat-settings?") && !init?.method) return ok({ items: [row] });
    if (url === "/api/chat-settings" && init?.method === "PATCH") {
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
    <MemoryRouter initialEntries={["/settings/connections/discord"]}>
      <ChatRulesSection connectionId="discord-1" />
    </MemoryRouter>,
  );
}

/** The chat's row, opened so its rules show. */
async function openCard(name: RegExp) {
  const heading = await screen.findByRole("heading", { name });
  const toggle = within(heading).getByRole("button");
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
  return heading.closest("article") as HTMLElement;
}

async function findCard() {
  return openCard(/engineering/);
}

/** Comfortably past AUTOSAVE_DEBOUNCE_MS, so "no PATCH" means it was dropped. */
const PAST_DEBOUNCE_MS = 800;

describe("ChatRulesSection", () => {
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
              connectionKind: "discord",
              label: "Discord · Rome",
              grants: {},
              display: {},
              capabilities: {
                chat: { state: "unlocked" },
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
      if (url.startsWith("/api/chat-settings?") && !init?.method) {
        return url.includes("cursor=next")
          ? ok({ items: [item({ id: "releases", name: "releases" })] })
          : ok({ items: [parent], nextCursor: "next" });
      }
      if (url === "/api/chat-settings" && init?.method === "PATCH") {
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
      <MemoryRouter initialEntries={["/settings/connections/discord"]}>
        <ChatRulesSection connectionId="discord-1" />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const engineeringHeading = await screen.findByRole("heading", { name: /engineering/ });
    // The server names the group, so the row names only the chat, and the
    // summary says what the chat changed.
    expect(screen.getByRole("heading", { name: "Rome" })).toBeTruthy();
    expect(within(engineeringHeading).getByText("Only when addressed")).toBeTruthy();
    const engineeringRow = await openCard(/engineering/);

    // The list asks only for the chats a value was set on.
    expect(
      fetchMock.mock.calls.some(
        ([request]) =>
          String(request).includes("connectionId=discord-1") &&
          String(request).includes("changed=true"),
      ),
    ).toBe(true);
    // The fixture overrides exactly one field (activation.mode), so a single
    // marker proves changed rules are flagged and default ones are not.
    expect(within(engineeringRow).getAllByText("Changed from the default")).toHaveLength(1);

    await user.click(within(engineeringRow).getByRole("switch", { name: "Rome in this chat" }));
    await choose(user, within(engineeringRow).getByLabelText(/Respond/), "Every message");
    // The canonical id comes from /api/agents. Its owner remains visible for
    // disambiguation, while selecting it preserves the runtime value.
    await choose(user, within(engineeringRow).getByLabelText(/Agent/), "build · coding");
    await choose(user, within(engineeringRow).getByLabelText(/Provider session reset/), "Daily");

    // No save button: the edits persist on their own, coalesced into one PATCH
    // because they landed inside a single debounce window.
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toMatchObject({
      ref: { connectionId: "discord-1", chatId: "engineering" },
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

  it("shows a silent account instead of the agent picker", async () => {
    const connection = (service: string, linked: { agent?: string | null }) => ({
      id: `${service}-1`,
      connectionKind: service,
      label: service,
      grants: {},
      display: {},
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      link: linkOf(service),
      ...linked,
    });
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/connections") {
        return ok({
          connections: [
            connection("discord", { agent: null }),
            connection("feishu", { agent: "sales:agent" }),
          ],
        });
      }
      if (url === "/api/agents") return ok({ agents: [{ name: "core:main" }] });
      if (url.startsWith("/api/chat-settings?")) {
        return ok({
          items: [
            item({
              id: "engineering",
              name: "engineering",
              overrides: { routing: { agentName: "coding:build" } },
            }),
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch);

    renderPage();
    // The stored agent choice has no effect yet, so the row does not list it.
    expect(
      within(await screen.findByRole("heading", { name: /engineering/ })).getByText(
        "Follows the defaults",
      ),
    ).toBeTruthy();
    const silent = await findCard();
    expect(within(silent).queryByLabelText(/Agent/)).toBeNull();
    expect(within(silent).getByText("None. Rome does not listen to this account.")).toBeTruthy();
    expect(
      within(silent).getByRole("link", { name: "Link one in Envoys" }).getAttribute("href"),
    ).toBe("/envoys");
    // The panel says the stored choice applies once an agent is linked.
    expect(within(silent).getByText(/This chat's choice, build · coding, applies/)).toBeTruthy();
  });

  it("offers a linked account's agent for a conversation with no agent of its own", async () => {
    const patchBodies: unknown[] = [];
    const row = item({ id: "engineering", name: "engineering" });
    rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/connections") {
        return ok({
          connections: [
            {
              id: "discord-1",
              connectionKind: "discord",
              label: "Discord · Rome",
              grants: {},
              display: {},
              capabilities: {
                chat: { state: "unlocked" },
                act: { state: "unsupported" },
                watch: { state: "unsupported" },
              },
              connect: null,
              agent: "sales:agent",
              link: "own_account",
            },
          ],
        });
      }
      if (url === "/api/agents") return ok({ agents: [{ name: "core:main" }] });
      if (url.startsWith("/api/chat-settings?")) return ok({ items: [row] });
      if (url === "/api/chat-settings" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patchBodies.push(body);
        return ok({
          ...row.snapshot,
          overrides: body.clear.length > 0 ? {} : { routing: { agentName: null } },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch);

    renderPage();
    const user = userEvent.setup();
    const card = await findCard();
    const picker = within(card).getByLabelText(/Agent/);
    expect(picker.textContent).toBe("agent · sales (this account's agent)");

    // Main is a choice of its own here, which keeps the conversation on main.
    await choose(user, picker, "main");
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toMatchObject({ set: { routing: { agentName: "main" } }, clear: [] });
    await waitFor(() => expect(picker.textContent).toBe("main"));

    await choose(user, picker, "agent · sales (this account's agent)");
    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toMatchObject({ set: {}, clear: ["routing.agentName"] });
    await waitFor(() => expect(picker.textContent).toBe("agent · sales (this account's agent)"));
  });

  it("restores the account's agent when moving off it fails", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/connections") {
        return ok({
          connections: [
            {
              id: "discord-1",
              connectionKind: "discord",
              label: "Discord · Rome",
              grants: {},
              display: {},
              capabilities: { chat: { state: "unlocked" } },
              connect: null,
              agent: "sales:agent",
              link: "own_account",
            },
          ],
        });
      }
      if (url === "/api/agents") return ok({ agents: [{ name: "core:main" }] });
      if (url.startsWith("/api/chat-settings?")) {
        return ok({ items: [item({ id: "engineering", name: "engineering" })] });
      }
      if (init?.method === "PATCH") throw new Error("network down");
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch);

    renderPage();
    const user = userEvent.setup();
    const picker = within(await findCard()).getByLabelText(/Agent/);
    await choose(user, picker, "main");
    await waitFor(() => expect(picker.textContent).toBe("agent · sales (this account's agent)"));
  });

  it("creates no override when an edit is undone before the debounce elapses", async () => {
    const { patchBodies } = mockApi();
    renderPage();
    const user = userEvent.setup();
    const card = await findCard();
    const toggle = within(card).getByRole("switch", { name: "Rome in this chat" });

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
    const toggle = within(card).getByRole("switch", { name: "Rome in this chat" });

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

    await user.click(within(card).getByRole("switch", { name: "Rome in this chat" }));
    expect(patchBodies).toEqual([]);

    view.unmount();

    await waitFor(() => expect(patchBodies).toHaveLength(1));
  });

  it("keeps a concurrent edit when an unrelated save fails", async () => {
    const { patchBodies, failFirstPatch } = mockApi({ deferFirstPatch: true });
    renderPage();
    const user = userEvent.setup();
    const card = await findCard();

    await user.click(within(card).getByRole("switch", { name: "Rome in this chat" }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));

    // Second edit lands while the first PATCH is still open, then that one fails.
    await choose(user, within(card).getByLabelText(/Respond/), "Every message");
    failFirstPatch();

    // Rolling the whole draft back to the confirmed snapshot would wipe this
    // edit, and the next flush would then diff it away as a no-op — losing it
    // from the UI and the server both.
    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toMatchObject({ set: { activation: { mode: "all" } } });
    expect(within(card).getByLabelText(/Respond/).textContent).toContain("Every message");
  });

  it("sends an edit made while the previous save is still in flight", async () => {
    const { patchBodies, resolveFirstPatch } = mockApi({ deferFirstPatch: true });
    renderPage();
    const user = userEvent.setup();
    const card = await findCard();
    const toggle = within(card).getByRole("switch", { name: "Rome in this chat" });

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
      if (url.startsWith("/api/chat-settings?")) {
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
    expect(screen.queryByText("Every chat follows the defaults")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Every chat follows the defaults")).toBeTruthy();
    expect(settingsLoads).toBe(2);
  });

  it("states the defaults the other chats follow", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/connections") {
        return ok({
          connections: [
            {
              id: "discord-1",
              connectionKind: "discord",
              capabilities: { chat: { state: "unlocked" } },
              chatRules: ["activation.mode", "replies.placement", "session.reset"],
              chatRuleDefaults: defaults,
            },
          ],
        });
      }
      if (url === "/api/agents") return ok({ agents: [] });
      if (url.startsWith("/api/chat-settings?")) return ok({ items: [] });
      throw new Error(`Unexpected request: GET ${url}`);
    }) as typeof fetch);

    renderPage();

    expect(
      await screen.findByText(
        "Only when addressed · Replies in a thread · Resets after 7 days idle",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Every other chat:")).toBeTruthy();
  });

  it("resets a chat to the defaults, which takes it off the list", async () => {
    const resets: unknown[] = [];
    rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/connections") return ok({ connections: [] });
      if (url === "/api/agents") return ok({ agents: [] });
      if (url.startsWith("/api/chat-settings?")) {
        return ok({
          items: [item({ id: "engineering", name: "engineering", overrides: { enabled: false } })],
        });
      }
      if (url === "/api/chat-settings/reset" && init?.method === "POST") {
        resets.push(JSON.parse(String(init.body)));
        return ok(item({ id: "engineering", name: "engineering" }).snapshot);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch);

    renderPage();
    const user = userEvent.setup();
    const card = await findCard();
    await user.click(within(card).getByRole("button", { name: "Reset to defaults" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: /engineering/ })).toBeNull());
    expect(resets).toEqual([{ ref: { connectionId: "discord-1", chatId: "engineering" } }]);
    expect(screen.getByText("Every chat follows the defaults")).toBeTruthy();
  });

  it("adds a chat from the dialog, open at its defaults", async () => {
    const fetchMock = rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url === "/api/connections") return ok({ connections: [] });
      if (url === "/api/agents") return ok({ agents: [] });
      if (url.startsWith("/api/chat-settings?") && url.includes("changed=true")) {
        return ok({
          items: [item({ id: "engineering", name: "engineering", overrides: { enabled: false } })],
        });
      }
      if (url.startsWith("/api/chat-settings?")) {
        return ok({
          items: [
            item({ id: "engineering", name: "engineering", overrides: { enabled: false } }),
            item({ id: "design", name: "design" }),
          ],
        });
      }
      throw new Error(`Unexpected request: GET ${url}`);
    }) as typeof fetch);

    renderPage();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /engineering/ });
    await user.click(screen.getByRole("button", { name: "Add chat" }));

    const dialog = await screen.findByRole("dialog", { name: "Add a chat" });
    // A chat the list already shows is not offered again.
    const choice = await within(dialog).findByRole("button", { name: /design/ });
    expect(within(dialog).queryByRole("button", { name: /engineering/ })).toBeNull();
    await user.type(within(dialog).getByRole("textbox", { name: "Search chats" }), "des");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([request]) => String(request).includes("query=des"))).toBe(
        true,
      ),
    );
    await user.click(choice);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a chat" })).toBeNull());
    const heading = await screen.findByRole("heading", { name: /design/ });
    expect(within(heading).getByText("Follows the defaults")).toBeTruthy();
    expect(within(heading).getByRole("button").getAttribute("aria-expanded")).toBe("true");
  });
});
