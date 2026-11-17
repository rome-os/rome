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

interface PinState {
  set: boolean;
  lockedUntil: string | null;
}

interface MockOptions {
  pin?: PinState;
  /** Answers a write, or returns undefined for the default 200. */
  reply?: (write: Write) => Response | undefined;
  /** Answers the list instead of `secrets`. */
  list?: () => Response;
}

function mockVaultFetch(secrets: unknown[], options: MockOptions = {}): Write[] {
  const writes: Write[] = [];
  const pin = options.pin ?? { set: true, lockedUntil: null };
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!url.startsWith("/api/vault")) return ok({});
    if (method === "GET") return options.list?.() ?? ok({ secrets, pin });
    const write = { method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    writes.push(write);
    return options.reply?.(write) ?? ok({ ok: true });
  }) as typeof fetch);
  return writes;
}

const refuse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const PIN = "123456";

/** Types the PIN in the step before the form, and continues. */
async function passPinStep(pin = PIN) {
  await userEvent.type(await screen.findByLabelText("PIN"), pin);
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
}

const valueOf = async (label: string) =>
  ((await screen.findByLabelText(label)) as HTMLInputElement).value;

/** Opens the add form past the PIN step. */
async function openAddForm() {
  await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
  await passPinStep();
  await screen.findByRole("heading", { level: 2, name: "New secret" });
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

    await openAddForm();
    expect(screen.getByText("An agent can use this only after you approve it.")).toBeTruthy();
    // The PIN was asked before the form, so the form has no PIN field.
    expect(screen.queryByLabelText("PIN")).toBeNull();

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
        body: { value: "ghp_value", description: "Release token", pin: PIN },
      },
    ]);
  });

  it("hides the secret value until the eye is pressed", async () => {
    mockVaultFetch([]);
    renderVaultSheet();
    await openAddForm();
    const input = screen.getByLabelText("Secret value") as HTMLInputElement;
    await userEvent.type(input, "ghp_value");
    expect(input.type).toBe("password");
    const eye = screen.getByRole("button", { name: "Show value" });
    expect(eye.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(eye);
    expect(input.type).toBe("text");
    expect(input.value).toBe("ghp_value");
    const hide = screen.getByRole("button", { name: "Hide value" });
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(hide);
    expect(input.type).toBe("password");
  });

  it("sends no description when none is typed", async () => {
    const writes = mockVaultFetch([]);
    renderVaultSheet();
    await openAddForm();
    await userEvent.type(screen.getByLabelText("Name"), "STRIPE_API_KEY");
    await userEvent.type(screen.getByLabelText("Secret value"), "sk_live");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await rs.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ value: "sk_live", description: "", pin: PIN });
  });

  it("checks names against the vault rule, not the App keys rule", async () => {
    const writes = mockVaultFetch([]);
    renderVaultSheet();
    await openAddForm();
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
    await openAddForm();
    await userEvent.click(screen.getByRole("tab", { name: "Paste .env" }));
    await userEvent.click(screen.getByLabelText(".env content"));
    await userEvent.paste("AWS_ACCESS_KEY_ID=AKIA123\nROME_TOKEN=abc");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // One PIN covers the whole batch.
    await rs.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map(({ url, body }) => ({ url, body }))).toEqual([
      {
        url: "/api/vault/AWS_ACCESS_KEY_ID",
        body: { value: "AKIA123", description: "", pin: PIN },
      },
      { url: "/api/vault/ROME_TOKEN", body: { value: "abc", description: "", pin: PIN } },
    ]);
  });

  it("prefills a replace with the stored description, or nothing, and sends what is left", async () => {
    const writes = mockVaultFetch([used, idle]);
    renderVaultSheet();
    await screen.findByText("STRIPE_API_KEY");
    const replaces = screen.getAllByRole("button", { name: "Replace" });

    await userEvent.click(replaces[0]);
    await passPinStep();
    expect(await valueOf("What is this secret for?")).toBe("GitHub token for releases");
    await userEvent.type(screen.getByLabelText("Secret value"), "new-value");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await rs.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({
      value: "new-value",
      description: "GitHub token for releases",
      pin: PIN,
    });

    await userEvent.click((await screen.findAllByRole("button", { name: "Replace" }))[1]);
    await passPinStep();
    expect(await valueOf("What is this secret for?")).toBe("");
    await userEvent.type(screen.getByLabelText("Secret value"), "other");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await rs.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].body).toEqual({ value: "other", description: "", pin: PIN });
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

describe("Vault PIN step", () => {
  const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const continueButton = () => button("Continue");
  const wrongPin = () => refuse(403, { error: "wrong_pin", attemptsLeft: 2 });
  const invalidSlots = () =>
    document.querySelectorAll('[data-slot="input-otp-slot"][aria-invalid="true"]');

  it("asks for a new PIN twice first, sets it at once, then shows the form", async () => {
    const writes = mockVaultFetch([], { pin: { set: false, lockedUntil: null } });
    renderVaultSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Set PIN" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Forgot PIN?" })).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(continueButton().disabled).toBe(true);

    await userEvent.type(field("New PIN"), PIN);
    await userEvent.type(field("Confirm PIN"), "654321");
    await userEvent.click(continueButton());
    expect((await screen.findByRole("alert")).textContent).toBe("The PINs do not match.");
    expect(writes).toEqual([]);

    await userEvent.clear(field("Confirm PIN"));
    await userEvent.type(field("Confirm PIN"), PIN);
    await userEvent.click(continueButton());
    expect(await screen.findByRole("heading", { level: 2, name: "New secret" })).toBeTruthy();
    expect(writes).toEqual([{ method: "POST", url: "/api/vault/pin", body: { pin: PIN } }]);

    await userEvent.type(screen.getByLabelText("Name"), "STRIPE_API_KEY");
    await userEvent.type(screen.getByLabelText("Secret value"), "sk_live");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await rs.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({
      method: "PUT",
      url: "/api/vault/STRIPE_API_KEY",
      body: { value: "sk_live", description: "", pin: PIN },
    });
  });

  it("moves to entering the PIN when setting it finds one already set", async () => {
    const pin = { set: false, lockedUntil: null as string | null };
    const writes = mockVaultFetch([], {
      pin,
      reply: () => {
        pin.set = true;
        return refuse(409, { error: "pin_already_set" });
      },
    });
    renderVaultSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    await userEvent.type(await screen.findByLabelText("New PIN"), PIN);
    await userEvent.type(field("Confirm PIN"), PIN);
    await userEvent.click(continueButton());

    expect(await screen.findByRole("heading", { level: 2, name: "Enter PIN" })).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toBe("Failed to set the PIN.");
    expect(screen.queryByLabelText("Confirm PIN")).toBeNull();
    expect(writes).toHaveLength(1);
  });

  it("asks for the PIN once when one is set, and checks nothing before the save", async () => {
    const writes = mockVaultFetch([]);
    renderVaultSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Enter PIN" })).toBeTruthy();
    expect(screen.queryByLabelText("Confirm PIN")).toBeNull();
    expect(screen.getByRole("button", { name: "Forgot PIN?" })).toBeTruthy();

    // Only digits go in, and Continue waits for six.
    await userEvent.type(await screen.findByLabelText("PIN"), "12ab345");
    expect(field("PIN").value).toBe("12345");
    expect(continueButton().disabled).toBe(true);
    await userEvent.type(field("PIN"), "6");
    await userEvent.click(continueButton());
    expect(await screen.findByRole("heading", { level: 2, name: "New secret" })).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it("shows the PIN digits while the eye is pressed, and masks them by default", async () => {
    mockVaultFetch([]);
    renderVaultSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    await userEvent.type(await screen.findByLabelText("PIN"), "12");
    const slotText = () =>
      [...document.querySelectorAll('[data-slot="input-otp-slot"]')].map((s) => s.textContent);
    expect(slotText().slice(0, 2)).toEqual(["", ""]);
    expect(document.querySelectorAll('[data-slot="input-otp-dot"]')).toHaveLength(2);

    await userEvent.click(button("Show PIN"));
    expect(button("Hide PIN").getAttribute("aria-pressed")).toBe("true");
    expect(slotText().slice(0, 2)).toEqual(["1", "2"]);
  });

  it("returns to the list from the PIN step and from the form", async () => {
    mockVaultFetch([]);
    renderVaultSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    await userEvent.click(await screen.findByRole("button", { name: "Back to the vault" }));
    expect(await screen.findByText("Nothing in the vault yet")).toBeTruthy();

    await openAddForm();
    await userEvent.click(screen.getByRole("button", { name: "Back to the vault" }));
    expect(await screen.findByText("Nothing in the vault yet")).toBeTruthy();
  });

  it("goes back to the PIN step on a wrong PIN, with the error, and keeps the form values", async () => {
    const writes = mockVaultFetch([], { reply: wrongPin });
    renderVaultSheet();
    await openAddForm();
    await userEvent.type(screen.getByLabelText("Name"), "STRIPE_API_KEY");
    await userEvent.type(screen.getByLabelText("Secret value"), "sk_live");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Enter PIN" })).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong PIN. 2 tries left.");
    expect(field("PIN").value).toBe("");
    expect(writes).toHaveLength(1);
    // The refused PIN marks the slots, and typing again clears the mark.
    expect(invalidSlots()).toHaveLength(6);
    await userEvent.type(field("PIN"), "6");
    expect(invalidSlots()).toHaveLength(0);
    await userEvent.clear(field("PIN"));

    await passPinStep("654321");
    expect(await screen.findByRole("heading", { level: 2, name: "New secret" })).toBeTruthy();
    expect(field("Name").value).toBe("STRIPE_API_KEY");
    expect(field("Secret value").value).toBe("sk_live");
    // The next Continue sends nothing. Only a save spends an attempt.
    expect(writes).toHaveLength(1);
  });

  it.each([
    [
      423,
      { error: "locked", lockedUntil: new Date(Date.now() + 15 * 60_000).toISOString() },
      /^Locked\./,
    ],
    [409, { error: "pin_not_set" }, /^Set a PIN in Settings first\./],
  ])("returns to the PIN step on a %i from the save", async (status, body, line) => {
    mockVaultFetch([], { reply: () => refuse(status, body) });
    renderVaultSheet();
    await openAddForm();
    await userEvent.type(screen.getByLabelText("Name"), "STRIPE_API_KEY");
    await userEvent.type(screen.getByLabelText("Secret value"), "sk_live");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(line);
    expect(screen.queryByLabelText("Secret value")).toBeNull();
  });

  it("stops a pasted .env batch at the first refused PIN and returns to the PIN step", async () => {
    const writes = mockVaultFetch([], { reply: wrongPin });
    renderVaultSheet();
    await openAddForm();
    await userEvent.click(screen.getByRole("tab", { name: "Paste .env" }));
    await userEvent.click(screen.getByLabelText(".env content"));
    await userEvent.paste("ONE_KEY=1\nTWO_KEY=2\nTHREE_KEY=3");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Wrong PIN. 2 tries left.");
    expect(screen.getByRole("heading", { level: 2, name: "Enter PIN" })).toBeTruthy();
    expect(writes).toHaveLength(1);

    // Nothing is lost: the whole batch is still in the form.
    await passPinStep();
    const kept = (await screen.findByLabelText(".env content")) as HTMLTextAreaElement;
    expect(kept.value).toContain("ONE_KEY=1");
    expect(kept.value).toContain("THREE_KEY=3");
    expect(writes).toHaveLength(1);
  });

  it("disables the PIN field and shows the lock while locked, with Forgot PIN? still open", async () => {
    mockVaultFetch([], {
      pin: { set: true, lockedUntil: new Date(Date.now() + 10 * 60_000).toISOString() },
    });
    renderVaultSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    expect(((await screen.findByLabelText("PIN")) as HTMLInputElement).disabled).toBe(true);
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Locked\. Try again at /);
    expect(continueButton().disabled).toBe(true);
    expect(button("Forgot PIN?").disabled).toBe(false);
  });

  it("resets from the PIN step, then continues to the form with the new PIN", async () => {
    const writes = mockVaultFetch([used, idle]);
    renderVaultSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    await userEvent.click(await screen.findByRole("button", { name: "Forgot PIN?" }));

    const dialog = await screen.findByRole("dialog", { name: /^Delete all 2 secrets\?/ });
    const reset = within(dialog).getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText("New PIN"), "654321");
    await userEvent.type(within(dialog).getByLabelText("Confirm PIN"), "654320");
    expect(reset.disabled).toBe(true);
    await userEvent.clear(within(dialog).getByLabelText("Confirm PIN"));
    await userEvent.type(within(dialog).getByLabelText("Confirm PIN"), "654321");
    await userEvent.click(reset);

    expect(await screen.findByRole("heading", { level: 2, name: "New secret" })).toBeTruthy();
    expect(writes).toEqual([{ method: "POST", url: "/api/vault/reset", body: { pin: "654321" } }]);

    await userEvent.type(screen.getByLabelText("Name"), "STRIPE_API_KEY");
    await userEvent.type(screen.getByLabelText("Secret value"), "sk_live");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await rs.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].body).toEqual({ value: "sk_live", description: "", pin: "654321" });
  });

  it("shows one line instead of the list when the signer is too old", async () => {
    mockVaultFetch([], {
      list: () =>
        refuse(503, {
          error: "The signer is too old for the vault. Upgrade the instance.",
          code: "signer_outdated",
        }),
    });
    renderVaultSheet();
    expect(
      await screen.findByText("The signer is too old for the vault. Upgrade the instance."),
    ).toBeTruthy();
    expect(screen.queryByText("The vault couldn't be loaded")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add secret" })).toBeNull();
  });
});
