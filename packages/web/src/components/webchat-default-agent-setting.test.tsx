// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { agentCatalogLabel } from "@/components/chat/composer/AgentMentionMenu";
import type { AgentCatalogGroup } from "@/lib/chat-types";
import { WebchatDefaultAgentSetting } from "./webchat-default-agent-setting";

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

// Webchat's catalog as GET /api/chat/agents serves it: apps first, Rome last.
const CATALOG: AgentCatalogGroup[] = [
  {
    ownerId: "coding",
    ownerType: "app",
    label: "Coding",
    description: "Code in your projects",
    iconUrl: "/api/apps/coding/icon",
    agents: [
      { name: "coding:coding", localName: "coding", description: "Writes and edits code." },
      { name: "coding:planning", localName: "planning", description: "Plans the change first." },
    ],
  },
  {
    ownerId: "core",
    ownerType: "core",
    label: "Rome",
    description: "",
    iconUrl: null,
    agents: [
      { name: "core:envoy", localName: "envoy", description: "Checks outgoing actions." },
      { name: "core:main", localName: "main", description: "Main orchestrator." },
    ],
  },
];

type Saved = { agentName: string; ownerAppId: string } | null;

/** A backend holding one saved row, like the instance settings store. */
function mockBackend(initial: Saved, loaded = true) {
  const state = { saved: initial };
  const puts: unknown[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url === "/api/chat/agents") return json(structuredClone(CATALOG));
    if (url === "/api/chat/default-agent" && init?.method === "PUT") {
      const { agentName } = JSON.parse(String(init.body)) as { agentName: string };
      puts.push({ agentName });
      state.saved =
        agentName === "core:main"
          ? null
          : { agentName, ownerAppId: agentName.split(":")[0] as string };
    }
    if (url === "/api/chat/default-agent") {
      const effective = state.saved && loaded ? state.saved.agentName : "main";
      return json({ saved: state.saved, effective });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return { state, puts };
}

function renderSetting() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WebchatDefaultAgentSetting />
    </QueryClientProvider>,
  );
}

const trigger = () => screen.getByRole("button", { name: "Default agent for new chats" });

async function openChooser(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect((trigger() as HTMLButtonElement).disabled).toBe(false));
  await user.click(trigger());
  return screen.findByRole("menu");
}

describe("Webchat default agent setting", () => {
  it("offers exactly Webchat's agent catalog, grouped and labeled like the @-agent chooser", async () => {
    mockBackend(null);
    const user = userEvent.setup();
    renderSetting();

    const menu = await openChooser(user);

    const groups = Array.from(
      menu.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-group"]'),
    );
    expect(groups.map((group) => group.firstChild?.textContent)).toEqual(
      CATALOG.map((group) => group.label),
    );
    groups.forEach((group, index) => {
      const agents = CATALOG[index]?.agents ?? [];
      expect(
        within(group)
          .getAllByRole("menuitemradio")
          .map((item) => item.textContent),
      ).toEqual(agents.map((agent) => `${agentCatalogLabel(agent)}${agent.description}`));
    });
  });

  it("shows Rome's main agent when no choice was ever saved", async () => {
    mockBackend(null);
    const user = userEvent.setup();
    renderSetting();

    await waitFor(() => expect(trigger().textContent).toBe("Rome · main"));
    const menu = await openChooser(user);
    expect(
      within(menu).getByRole("menuitemradio", { name: /^main/ }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("saves a choice as soon as it is picked and keeps it after a reload", async () => {
    const backend = mockBackend(null);
    const user = userEvent.setup();
    const view = renderSetting();

    const menu = await openChooser(user);
    await user.click(within(menu).getByRole("menuitemradio", { name: /^coding/ }));

    await waitFor(() => expect(backend.puts).toEqual([{ agentName: "coding:coding" }]));
    await waitFor(() => expect(trigger().textContent).toBe("Coding · coding"));
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();

    view.unmount();
    renderSetting();
    await waitFor(() => expect(trigger().textContent).toBe("Coding · coding"));
  });

  it("clears the saved choice when the main agent is picked", async () => {
    const backend = mockBackend({ agentName: "coding:coding", ownerAppId: "coding" });
    const user = userEvent.setup();
    renderSetting();

    const menu = await openChooser(user);
    await user.click(within(menu).getByRole("menuitemradio", { name: /^main/ }));

    await waitFor(() => expect(backend.state.saved).toBeNull());
    await waitFor(() => expect(trigger().textContent).toBe("Rome · main"));
  });

  it("shows the main agent while the saved agent is not loaded", async () => {
    mockBackend({ agentName: "coding:coding", ownerAppId: "coding" }, false);
    renderSetting();

    await waitFor(() => expect(trigger().textContent).toBe("Rome · main"));
    expect(screen.getByText(/saved agent isn't loaded right now/)).toBeTruthy();
  });
});
