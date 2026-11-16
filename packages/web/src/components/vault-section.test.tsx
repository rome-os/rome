// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FormRows } from "@rome-os/ui/layout-form";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { VaultRow } from "./app-keys-section";

rs.mock("sonner", () => ({
  toast: Object.assign(
    rs.fn(() => "toast-id"),
    { success: rs.fn(), warning: rs.fn(), error: rs.fn(), dismiss: rs.fn() },
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

interface Write {
  method: string;
  url: string;
  body: unknown;
}

function mockVaultFetch(secrets: unknown[]): Write[] {
  const writes: Write[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!url.startsWith("/api/vault")) return ok({});
    if (method === "GET") return ok({ secrets });
    writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return ok({ ok: true });
  }) as typeof fetch);
  return writes;
}

function renderVaultSheet() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <FormRows>
        <VaultRow />
      </FormRows>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Vault" }));
}

const used = {
  name: "GITHUB_TOKEN",
  description: "GitHub token for releases",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  lastUsedAt: "2026-11-14T09:30:00.000Z",
  grantedUntil: "2099-01-01T10:30:00.000Z",
};
const idle = {
  name: "STRIPE_API_KEY",
  description: "",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  lastUsedAt: null,
};

describe("Vault row", () => {
  it("shows its title and the stored count", async () => {
    mockVaultFetch([used, idle]);
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <FormRows>
          <VaultRow />
        </FormRows>
      </QueryClientProvider>,
    );
    expect(screen.getByText("Vault")).toBeTruthy();
    expect(await screen.findByText(/^2 secrets · /)).toBeTruthy();
  });
});

describe("Vault sheet", () => {
  it("lists secrets with last use and a granted-until badge, never a value", async () => {
    mockVaultFetch([used, idle]);
    renderVaultSheet();

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "Vault" })).toBeTruthy();
    expect(await screen.findByText("GitHub token for releases")).toBeTruthy();
    expect(screen.getByText("GITHUB_TOKEN")).toBeTruthy();
    expect(screen.getByText("STRIPE_API_KEY")).toBeTruthy();
    expect(screen.getByText(/^Used /)).toBeTruthy();
    expect(screen.getByText("Never used")).toBeTruthy();
    // Only the live grant carries a badge.
    expect(screen.getAllByText(/^Granted until /)).toHaveLength(1);
    expect(screen.getAllByText("Value hidden")).toHaveLength(2);
  });

  it("shows the empty state", async () => {
    mockVaultFetch([]);
    renderVaultSheet();
    expect(await screen.findByText("Nothing in the vault yet")).toBeTruthy();
  });

  it("saves a secret through the add form", async () => {
    const writes = mockVaultFetch([]);
    renderVaultSheet();

    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    expect(screen.getByRole("heading", { level: 2, name: "New secret" })).toBeTruthy();
    expect(screen.getByText("An agent can use this only after you approve it.")).toBeTruthy();

    await userEvent.type(screen.getByLabelText("What is this secret for?"), "Release token");
    await userEvent.type(screen.getByLabelText("Name"), "github_token");
    await userEvent.type(screen.getByLabelText("Secret value"), "ghp_value");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const { toast } = await import("sonner");
    await rs.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Saved GITHUB_TOKEN."));
    expect(writes).toEqual([
      {
        method: "PUT",
        url: "/api/vault/GITHUB_TOKEN",
        body: { value: "ghp_value", description: "Release token" },
      },
    ]);
  });

  it("sends no description when none is typed", async () => {
    const writes = mockVaultFetch([]);
    renderVaultSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    await userEvent.type(screen.getByLabelText("Name"), "STRIPE_API_KEY");
    await userEvent.type(screen.getByLabelText("Secret value"), "sk_live");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await rs.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ value: "sk_live", description: "" });
  });

  it("checks names against the vault rule, not the App keys rule", async () => {
    const writes = mockVaultFetch([]);
    renderVaultSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    await userEvent.type(screen.getByLabelText("Name"), "1BAD");
    await userEvent.type(screen.getByLabelText("Secret value"), "v");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Name must be");
    expect(writes).toHaveLength(0);

    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "AWS_SECRET_ACCESS_KEY");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await rs.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].url).toBe("/api/vault/AWS_SECRET_ACCESS_KEY");
  });

  it("imports pasted .env lines, including names App keys reserve", async () => {
    const writes = mockVaultFetch([]);
    renderVaultSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paste .env" }));
    await userEvent.click(screen.getByLabelText(".env content"));
    await userEvent.paste("AWS_ACCESS_KEY_ID=AKIA123\nROME_TOKEN=abc");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await rs.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map(({ url, body }) => ({ url, body }))).toEqual([
      {
        url: "/api/vault/AWS_ACCESS_KEY_ID",
        body: { value: "AKIA123", description: "" },
      },
      { url: "/api/vault/ROME_TOKEN", body: { value: "abc", description: "" } },
    ]);
  });

  it("prefills a replace with the stored description, or nothing, and sends what is left", async () => {
    const writes = mockVaultFetch([used, idle]);
    renderVaultSheet();
    await screen.findByText("STRIPE_API_KEY");
    const replaces = screen.getAllByRole("button", { name: "Replace" });

    await userEvent.click(replaces[0]);
    expect((screen.getByLabelText("What is this secret for?") as HTMLInputElement).value).toBe(
      "GitHub token for releases",
    );
    await userEvent.type(screen.getByLabelText("Secret value"), "new-value");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await rs.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({
      value: "new-value",
      description: "GitHub token for releases",
    });

    await userEvent.click((await screen.findAllByRole("button", { name: "Replace" }))[1]);
    expect((screen.getByLabelText("What is this secret for?") as HTMLInputElement).value).toBe("");
    await userEvent.type(screen.getByLabelText("Secret value"), "other");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await rs.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].body).toEqual({ value: "other", description: "" });
  });

  it("removes a secret after confirming", async () => {
    const writes = mockVaultFetch([used]);
    renderVaultSheet();

    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove GITHUB_TOKEN?")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    const { toast } = await import("sonner");
    await rs.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Removed GITHUB_TOKEN."));
    expect(writes).toEqual([{ method: "DELETE", url: "/api/vault/GITHUB_TOKEN", body: undefined }]);
  });
});
