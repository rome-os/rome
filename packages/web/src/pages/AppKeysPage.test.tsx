// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import AppKeysPage from "./AppKeysPage";
import SettingsPage from "./SettingsTabPage";

// The Toaster mounts in App.tsx, outside this tree — spy on the calls instead.
rs.mock("sonner", () => ({
  toast: Object.assign(
    rs.fn(() => "toast-id"),
    {
      success: rs.fn(),
      warning: rs.fn(),
      error: rs.fn(),
      dismiss: rs.fn(),
    },
  ),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function ok(json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface AppKeysCall {
  method: string;
  url: string;
  body: unknown;
}

function mockAppKeysFetch(
  loadKeys: () => Response | Promise<Response>,
  onWrite?: (call: AppKeysCall) => Response | Promise<Response>,
): AppKeysCall[] {
  const writes: AppKeysCall[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/settings") return ok({});
    if (url === "/api/tailscale/devices") {
      return ok({ mode: "oauth", configured: false, devices: [] });
    }
    if (url === "/api/integrations/composio/status") return ok({});
    if (url === "/api/connections") return ok({ connections: [] });
    if (url.startsWith("/api/app-keys")) {
      if (method === "GET") return loadKeys();
      const call: AppKeysCall = {
        method,
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      writes.push(call);
      if (onWrite) return onWrite(call);
      return ok({ ok: true, overridden: false });
    }
    return ok({});
  }) as typeof fetch);
  return writes;
}

function renderAppKeysPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings/connections/app-keys"]}>
        <Routes>
          <Route path="/settings/connections/app-keys" element={<AppKeysPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderConnectionsSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings/connections"]}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const storedKey = {
  name: "SHOP_DB_PASSWORD",
  label: "My shop database password",
  updatedAt: "2026-08-27T00:00:00.000Z",
  overridden: false,
};

describe("Connections tab app keys entry row", () => {
  it("links to the app keys page and shows the stored-key count", async () => {
    mockAppKeysFetch(() => ok({ keys: [storedKey] }));

    renderConnectionsSettings();

    const row = await screen.findByRole("link", { name: "Open App keys" });
    expect(row.getAttribute("href")).toBe("/settings/connections/app-keys");
    expect(await within(row).findByText("1 key")).toBeTruthy();
    // The management ceremony lives on the page, not the tab.
    expect(screen.queryByRole("button", { name: "Add key" })).toBeNull();
  });

  it("reads 'None yet' when no keys are stored", async () => {
    mockAppKeysFetch(() => ok({ keys: [] }));

    renderConnectionsSettings();

    const row = await screen.findByRole("link", { name: "Open App keys" });
    expect(await within(row).findByText("None yet")).toBeTruthy();
  });
});

describe("App keys page", () => {
  it("lists stored keys with label and name — never the value, no badge unless overridden", async () => {
    mockAppKeysFetch(() => ok({ keys: [storedKey] }));

    renderAppKeysPage();

    expect(await screen.findByRole("heading", { level: 1, name: "App keys" })).toBeTruthy();
    expect(await screen.findByText("My shop database password")).toBeTruthy();
    expect(screen.getByText("SHOP_DB_PASSWORD")).toBeTruthy();
    expect(screen.queryByText("Overridden by server settings")).toBeNull();
  });

  it("links back to the connections list", async () => {
    mockAppKeysFetch(() => ok({ keys: [] }));

    renderAppKeysPage();

    const back = await screen.findByRole("link", { name: "Connections" });
    expect(back.getAttribute("href")).toBe("/settings/connections");
  });

  it("shows the empty state when no keys exist", async () => {
    mockAppKeysFetch(() => ok({ keys: [] }));

    renderAppKeysPage();

    expect(await screen.findByText("No app keys yet")).toBeTruthy();
  });

  it("saves a new key through the add form with the all-apps consent visible", async () => {
    const writes = mockAppKeysFetch(() => ok({ keys: [] }));

    renderAppKeysPage();

    await userEvent.click(await screen.findByRole("button", { name: "Add key" }));

    expect(screen.getByRole("heading", { level: 2, name: "New key" })).toBeTruthy();
    expect(
      screen.getByText("Any app installed on your Rome will be able to read this."),
    ).toBeTruthy();

    await userEvent.type(
      screen.getByLabelText("What is this key for?"),
      "My shop database password",
    );
    await userEvent.type(screen.getByLabelText("Name apps use"), "shop_db_password");
    await userEvent.type(screen.getByLabelText("Secret value"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));

    const { toast } = await import("sonner");
    await rs.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved. Apps can now read SHOP_DB_PASSWORD."),
    );
    expect(writes).toHaveLength(1);
    // The name input upcases as the user types.
    expect(writes[0].url).toBe("/api/app-keys/SHOP_DB_PASSWORD");
    expect(writes[0].method).toBe("PUT");
    expect(writes[0].body).toEqual({
      label: "My shop database password",
      value: "hunter2",
    });
  });

  it("rejects a reserved name client-side without calling the API", async () => {
    const writes = mockAppKeysFetch(() => ok({ keys: [] }));

    renderAppKeysPage();

    await userEvent.click(await screen.findByRole("button", { name: "Add key" }));
    await userEvent.type(screen.getByLabelText("Name apps use"), "ROME_PROFILE");
    await userEvent.type(screen.getByLabelText("Secret value"), "v");
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));

    expect(
      await screen.findByText(
        "Names starting with ROME_ are reserved by Rome. Pick a different name.",
      ),
    ).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  it("imports .env keys, preserves existing labels and refreshes the list", async () => {
    let saved = false;
    const writes = mockAppKeysFetch(
      () =>
        ok({
          keys: saved
            ? [storedKey, { ...storedKey, name: "OTHER_KEY", label: "OTHER_KEY" }]
            : [storedKey],
        }),
      () => {
        saved = true;
        return ok({ ok: true, overridden: false });
      },
    );
    renderAppKeysPage();
    await userEvent.click(await screen.findByRole("button", { name: "Add key" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paste .env" }));
    await userEvent.click(screen.getByLabelText(".env content"));
    await userEvent.paste('# credentials\nSHOP_DB_PASSWORD="new#secret"\nexport OTHER_KEY=value==');
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));

    expect(await screen.findByText("OTHER_KEY")).toBeTruthy();
    expect(writes.map(({ url, body }) => ({ url, body }))).toEqual([
      {
        url: "/api/app-keys/SHOP_DB_PASSWORD",
        body: { label: storedKey.label, value: "new#secret" },
      },
      { url: "/api/app-keys/OTHER_KEY", body: { label: "OTHER_KEY", value: "value==" } },
    ]);
    expect(screen.queryByLabelText(".env content")).toBeNull();
    expect(screen.queryByText("new#secret")).toBeNull();
  });

  it("validates the entire .env input before writing any keys", async () => {
    const writes = mockAppKeysFetch(() => ok({ keys: [] }));
    renderAppKeysPage();
    await userEvent.click(await screen.findByRole("button", { name: "Add key" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paste .env" }));
    await userEvent.click(screen.getByLabelText(".env content"));
    await userEvent.paste("GOOD_KEY=value\ninvalid line with secret");
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Line 2: Expected KEY=value");
    expect(writes).toHaveLength(0);
  });

  it("waits for the pending key list before saving a replacement label", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    const writes = mockAppKeysFetch(async () => (await promise).clone());
    renderAppKeysPage();
    await userEvent.click(await screen.findByRole("button", { name: "Add key" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paste .env" }));
    await userEvent.click(screen.getByLabelText(".env content"));
    await userEvent.paste("SHOP_DB_PASSWORD=new-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));

    expect(screen.getByRole("button", { name: "Saving…" }).matches(":disabled")).toBe(true);
    expect(writes).toHaveLength(0);
    resolve(ok({ keys: [storedKey] }));
    await screen.findByRole("button", { name: "Add key" });
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ label: storedKey.label, value: "new-secret" });
  });

  it.each([
    false,
    true,
  ])("keeps the batch intact when fetching labels fails (cached list: %s)", async (hasCachedList) => {
    let loadCount = 0;
    let recovered = false;
    const writes = mockAppKeysFetch(() => {
      loadCount++;
      if (recovered || (hasCachedList && loadCount === 1)) return ok({ keys: [storedKey] });
      return new Response(JSON.stringify({ error: "Cannot load existing keys" }), { status: 503 });
    });
    renderAppKeysPage();
    if (hasCachedList) await screen.findByText(storedKey.label);
    else await screen.findByText("App keys couldn't be loaded");
    await userEvent.click(screen.getByRole("button", { name: "Add key" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paste .env" }));
    await userEvent.click(screen.getByLabelText(".env content"));
    const content = "SHOP_DB_PASSWORD=new-secret\nNEW_KEY=another-secret";
    await userEvent.paste(content);
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));

    await rs.waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((alert) => alert.textContent === "Cannot load existing keys"),
      ).toBe(true),
    );
    expect(loadCount).toBe(2);
    expect(writes).toHaveLength(0);
    expect((screen.getByLabelText(".env content") as HTMLTextAreaElement).value).toBe(content);

    recovered = true;
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));
    await screen.findByRole("button", { name: "Add key" });
    expect(writes.map(({ body }) => body)).toEqual([
      { label: storedKey.label, value: "new-secret" },
      { label: "NEW_KEY", value: "another-secret" },
    ]);
  });

  it("retains only failed entries for retry and reports overridden saves", async () => {
    let fail = true;
    const writes = mockAppKeysFetch(
      () => ok({ keys: [] }),
      ({ url }) => {
        if (url.endsWith("BAD_KEY") && fail) {
          return new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
        }
        return ok({ ok: true, overridden: true });
      },
    );
    renderAppKeysPage();
    await userEvent.click(await screen.findByRole("button", { name: "Add key" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paste .env" }));
    await userEvent.click(screen.getByLabelText(".env content"));
    await userEvent.paste('GOOD_KEY=first\nBAD_KEY="second#value"');
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));

    expect((await screen.findByRole("alert")).textContent).toContain("1 saved, 1 failed");
    expect((screen.getByLabelText(".env content") as HTMLTextAreaElement).value).toBe(
      'BAD_KEY="second#value"',
    );
    const { toast } = await import("sonner");
    expect(toast.warning).toHaveBeenCalledWith(
      "Some saved keys are overridden by server settings. Their entered values are not in use.",
    );
    await rs.waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save for all apps" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));
    await screen.findByRole("button", { name: "Add key" });
    expect(writes.map(({ url }) => url)).toEqual([
      "/api/app-keys/GOOD_KEY",
      "/api/app-keys/BAD_KEY",
      "/api/app-keys/BAD_KEY",
    ]);
    expect(writes[2].body).toEqual({ label: "BAD_KEY", value: "second#value" });
  });

  it("disables editing during a batch and clears pasted secrets on cancel", async () => {
    let finish!: (response: Response) => void;
    mockAppKeysFetch(
      () => ok({ keys: [storedKey] }),
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderAppKeysPage();
    await userEvent.click(await screen.findByRole("button", { name: "Add key" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paste .env" }));
    await userEvent.click(screen.getByLabelText(".env content"));
    await userEvent.paste("NEW_KEY=secret");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Add key" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paste .env" }));
    expect((screen.getByLabelText(".env content") as HTMLTextAreaElement).value).toBe("");
    await userEvent.click(screen.getByLabelText(".env content"));
    await userEvent.paste("NEW_KEY=secret");
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));
    expect(screen.getByLabelText(".env content").matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Close" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Replace" }).matches(":disabled")).toBe(true);
    finish(ok({ ok: true, overridden: false }));
    await screen.findByRole("button", { name: "Add key" });
  });

  it("removes a key after confirmation", async () => {
    const writes = mockAppKeysFetch(
      () => ok({ keys: [storedKey] }),
      () => ok({ ok: true }),
    );

    renderAppKeysPage();

    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove SHOP_DB_PASSWORD?")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    const { toast } = await import("sonner");
    await rs.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Removed SHOP_DB_PASSWORD."));
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("DELETE");
    expect(writes[0].url).toBe("/api/app-keys/SHOP_DB_PASSWORD");
  });

  it("marks an operator-overridden key and warns on save", async () => {
    mockAppKeysFetch(
      () => ok({ keys: [{ ...storedKey, overridden: true }] }),
      () => ok({ ok: true, overridden: true }),
    );

    renderAppKeysPage();

    expect(await screen.findByText("Overridden by server settings")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    // Replace locks the name and only asks for a new value.
    expect(
      screen.getByRole("heading", { level: 2, name: "Replace SHOP_DB_PASSWORD" }),
    ).toBeTruthy();
    expect((screen.getByLabelText("Name apps use") as HTMLInputElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Secret value"), "new-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));

    const { toast } = await import("sonner");
    await rs.waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Saved, but a server setting with the same name takes precedence — the value you entered is not in use.",
      ),
    );
  });
});
