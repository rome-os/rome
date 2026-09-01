// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import SettingsPage from "./SettingsTabPage";

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

function ok(json: unknown): Response {
  return { ok: true, status: 200, json: async () => structuredClone(json) } as Response;
}

function mockSettingsBackend(options?: {
  cloudEmailAccess?: string[];
  failPut?: boolean;
  tailscaleMode?: "daemon" | "oauth";
}) {
  const putBodies: unknown[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url === "/api/settings") return ok({});
    if (url === "/api/tailscale/devices") {
      return options?.tailscaleMode === "daemon"
        ? ok({ mode: "daemon", status: "disconnected", configured: false, devices: [] })
        : ok({ mode: "oauth", configured: false, devices: [] });
    }
    if (url === "/api/public-access") {
      return ok({ enableAccessControl: false, allowedApps: [] });
    }
    if (url === "/api/dashboard-access") {
      if (init?.method === "PUT") {
        putBodies.push(JSON.parse(String(init.body)));
        if (options?.failPut) {
          return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
        }
        return ok({});
      }
      return ok({ cloudEmailAccess: options?.cloudEmailAccess ?? ["ada@example.com"] });
    }
    if (url === "/api/tailnet") {
      return ok({ tailnetDns: null, httpsEnabled: false, certReady: false });
    }
    if (url === "/api/uptime") return ok({ uptime: 120 });
    if (url === "/api/build-info") return ok({ sha: null, builtAt: null });
    if (url === "/api/diagnosis") {
      return ok({
        status: "ok",
        checkedAt: "2026-06-16T00:00:00.000Z",
        uptimeSeconds: 120,
        build: { version: null, sha: null, builtAt: null },
        upgradedSinceLastBoot: false,
        previousVersion: null,
        instance: { auth: "no_token", accountId: null, instanceId: null },
        database: { ok: true },
        channels: [],
        apps: { total: 0, failed: [], broken: [] },
      });
    }
    return ok({});
  }) as typeof fetch);
  return { putBodies };
}

function renderAdvancedSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings/advanced"]}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettingsPage Access Control section", () => {
  it.each([
    ["OAuth", "oauth", "Connect Tailscale"],
    ["daemon", "daemon", "Connect to Tailscale"],
  ] as const)("uses a standard outline connect button in %s mode", async (_label, mode, name) => {
    mockSettingsBackend({ tailscaleMode: mode });
    renderAdvancedSettings();

    const connectButton = await screen.findByRole("button", { name });
    expect(connectButton.dataset.variant).toBe("outline");
    expect(connectButton.dataset.size).toBe("md");
  });

  it("renders Access Control as the section title with Allowed emails before Tailscale", async () => {
    mockSettingsBackend();
    renderAdvancedSettings();

    const sectionTitle = await screen.findByRole("heading", {
      level: 2,
      name: "Access Control",
    });
    const emailsTitle = await screen.findByRole("heading", {
      level: 3,
      name: "Allowed emails",
    });
    const tailscaleTitle = await screen.findByRole("heading", { level: 3, name: "Tailscale" });

    // Tailscale is a subsection of Access Control, not a first-level section.
    expect(screen.queryByRole("heading", { level: 2, name: "Tailscale" })).toBeNull();

    // Document order: Access Control → Allowed emails → Tailscale.
    expect(
      sectionTitle.compareDocumentPosition(emailsTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      emailsTitle.compareDocumentPosition(tailscaleTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("lists the saved allowed emails with an account count and no save button", async () => {
    mockSettingsBackend({ cloudEmailAccess: ["ada@example.com", "lin@example.com"] });
    renderAdvancedSettings();

    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("lin@example.com")).toBeTruthy();
    expect(screen.getByText("2 accounts")).toBeTruthy();
    // Changes save automatically — there is no explicit save button.
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("adds an email on Enter and auto-saves the full list", async () => {
    const { putBodies } = mockSettingsBackend();
    renderAdvancedSettings();
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Add email address");
    await user.type(input, "lin@example.com{Enter}");

    expect(screen.getByText("lin@example.com")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByText("2 accounts")).toBeTruthy();
    await waitFor(() =>
      expect(putBodies).toEqual([{ cloudEmailAccess: ["ada@example.com", "lin@example.com"] }]),
    );
  });

  it("splits a pasted list into individual emails and auto-saves once", async () => {
    const { putBodies } = mockSettingsBackend({ cloudEmailAccess: [] });
    renderAdvancedSettings();
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Add email address");
    await user.click(input);
    await user.paste("ada@example.com, lin@example.com grace@example.com");

    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("lin@example.com")).toBeTruthy();
    expect(screen.getByText("grace@example.com")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    await waitFor(() =>
      // parseEmailTextarea sorts each pasted batch alphabetically.
      expect(putBodies).toEqual([
        { cloudEmailAccess: ["ada@example.com", "grace@example.com", "lin@example.com"] },
      ]),
    );
  });

  it("keeps an invalid address in the input with an error and does not save", async () => {
    const { putBodies } = mockSettingsBackend();
    renderAdvancedSettings();
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Add email address");
    await user.type(input, "not-an-email{Enter}");

    expect((input as HTMLInputElement).value).toBe("not-an-email");
    expect(screen.getByText("Invalid email address: not-an-email")).toBeTruthy();
    expect(putBodies).toEqual([]);
  });

  it("removes an email and auto-saves the remaining list", async () => {
    const { putBodies } = mockSettingsBackend({
      cloudEmailAccess: ["ada@example.com", "lin@example.com"],
    });
    renderAdvancedSettings();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Remove lin@example.com" }));
    expect(screen.queryByText("lin@example.com")).toBeNull();
    expect(screen.getByText("1 account")).toBeTruthy();
    await waitFor(() => expect(putBodies).toEqual([{ cloudEmailAccess: ["ada@example.com"] }]));
  });

  it("rolls the list back when auto-save fails", async () => {
    const { putBodies } = mockSettingsBackend({ failPut: true });
    renderAdvancedSettings();
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Add email address");
    await user.type(input, "lin@example.com{Enter}");

    await waitFor(() =>
      expect(putBodies).toEqual([{ cloudEmailAccess: ["ada@example.com", "lin@example.com"] }]),
    );
    // The rejected address is removed again; the saved list is untouched.
    await waitFor(() => expect(screen.queryByText("lin@example.com")).toBeNull());
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("1 account")).toBeTruthy();
  });
});
