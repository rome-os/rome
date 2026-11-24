// @rstest-environment jsdom
// Rule 1, the page's half, for the team verifier (packages/core/src/test/team):
// in the dashboard as the guardian sees it, Settings has a Team entry, and
// entering an email there and saving puts it on the dashboard email list the
// backend holds. The backend is a stand-in that keeps the list in memory,
// answers the settings read with none set, and every other read with 404. The result goes to the verifier's out
// folder; the run script reads the verdict from it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import { useSettingsBackdrop } from "@/hooks/use-settings-backdrop";
import { DashboardScaleProvider } from "@/hooks/use-preview-scale";
import { ThemeProvider } from "@/hooks/use-theme";
import { GuardianTimestampProvider } from "@/components/guardian-timestamp-provider";
import SettingsDialog from "./SettingsDialog";
import SettingsPage from "./SettingsPage";
import SettingsTabPage from "./SettingsTabPage";
import ConnectionDetailPage from "./ConnectionDetailPage";
import DeviceActivityPage from "./DeviceActivityPage";

const TEAMMATE_EMAIL = "teammate@team-verifier.test";
const OUT_DIR = join(process.cwd(), "..", "core", "src", "test", "team", "out");

interface Step {
  step: string;
  ok: boolean;
  detail: string;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The backend as the dashboard reaches it: signed in as the guardian, with the
 *  dashboard email list in memory and empty settings. */
function standInBackend() {
  const state = { list: [] as string[], saves: [] as unknown[] };
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (url.pathname === "/api/health") return json(200, { status: "ok" });
    if (url.pathname === "/api/bootstrap") return json(200, { phase: "ready" });
    if (url.pathname === "/api/settings") return json(200, {});
    if (url.pathname === "/api/auth/me") {
      return json(200, {
        kind: "guardian",
        userId: "guardian",
        displayName: "Guardian",
        avatarUrl: null,
      });
    }
    if (url.pathname === "/api/dashboard-access") {
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { cloudEmailAccess?: string[] };
        state.saves.push(body);
        state.list = body.cloudEmailAccess ?? [];
        return json(200, { cloudEmailAccess: state.list });
      }
      return json(200, { cloudEmailAccess: state.list });
    }
    return json(404, { error: "not_found" });
  }) as typeof fetch);
  return state;
}

/** Settings as App.tsx mounts it. App itself cannot load here: its dev pages
 *  import MDX, which the test build does not parse. Keep this tree in step with
 *  the Settings routes in App.tsx. */
function SettingsAsMounted() {
  const { settingsOpen, close } = useSettingsBackdrop();
  if (!settingsOpen) return null;
  return (
    <SettingsDialog onClose={close}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/connections/:serviceId" element={<ConnectionDetailPage />} />
        <Route path="/settings/devices/:deviceId" element={<DeviceActivityPage />} />
        <Route path="/settings/:tab" element={<SettingsTabPage />} />
      </Routes>
    </SettingsDialog>
  );
}

function renderDashboardAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <DashboardScaleProvider>
          <ThemeProvider>
            <GuardianTimestampProvider>
              <SettingsAsMounted />
            </GuardianTimestampProvider>
          </ThemeProvider>
        </DashboardScaleProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Opens Settings, follows the entry named `entry`, enters the email on that
 * page and saves it the way the page offers (Enter, or a Save, Invite, Add or
 * Send button). Records each step and writes them to `out`.
 */
async function driveSettings(entry: RegExp, out: string): Promise<Step[]> {
  const steps: Step[] = [];
  const record = (step: string, ok: boolean, detail = "") => {
    steps.push({ step, ok, detail });
    return ok;
  };
  const backend = standInBackend();
  const user = userEvent.setup();
  try {
    renderDashboardAt("/settings");

    const nav = await screen.findByRole("navigation", { name: "Settings" }, { timeout: 10_000 });
    const link = within(nav).queryByRole("link", { name: entry });
    const entries = within(nav)
      .queryAllByRole("link")
      .map((l) => l.textContent)
      .join(", ");
    if (!record(`Settings lists an entry named ${entry.source}`, link !== null, entries)) {
      return steps;
    }
    await user.click(link as HTMLElement);

    const input = await screen
      .findByRole("textbox", { name: /email/i }, { timeout: 5_000 })
      .catch(() => null);
    if (!record("the page has an email field", input !== null)) return steps;
    await user.type(input as HTMLElement, `${TEAMMATE_EMAIL}{Enter}`);

    const saved = () => backend.list.includes(TEAMMATE_EMAIL);
    const settle = (timeout: number) =>
      waitFor(() => (saved() ? undefined : Promise.reject(new Error("not saved"))), {
        timeout,
      }).catch(() => {});
    await settle(1_500);
    if (!saved()) {
      const button = screen.queryByRole("button", { name: /save|invite|add|send/i });
      if (button) await user.click(button);
      await settle(3_000);
    }
    record(
      "entering the email and saving puts it on the dashboard list",
      saved(),
      `saves=${JSON.stringify(backend.saves)}`,
    );
  } catch (error) {
    record(
      "the page could be driven",
      false,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await act(async () => {});
    mkdirSync(join(out, ".."), { recursive: true });
    const pass = steps.length > 0 && steps.every((s) => s.ok);
    writeFileSync(out, `${JSON.stringify({ pass, steps }, null, 2)}\n`);
  }
  return steps;
}

it("Settings > Team saves an email to the dashboard list", async () => {
  await driveSettings(/^team$/i, join(OUT_DIR, "web.json"));
}, 30_000);

// Proof of the driver: the Admins rows on Settings > Advanced save to the same
// list today, so driving them as the Team page must pass.
it("the driver passes on the Admins rows of Settings > Advanced", async () => {
  const steps = await driveSettings(/^advanced$/i, join(OUT_DIR, "web-proof.json"));
  expect(steps.every((s) => s.ok)).toBe(true);
}, 30_000);
