// @rstest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import type { RomeCreditsView } from "@rome/api-types/rome-credits";
import { AiToolsCard } from "./AiToolsCard";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function ok(json: unknown): Response {
  return { ok: true, status: 200, json: async () => structuredClone(json) } as Response;
}

function mockStatus(
  status: { claude: { loggedIn: boolean }; codex: { loggedIn: boolean } },
  credits: RomeCreditsView | null = null,
) {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    const url = String(input);
    if (url === "/api/ai-tools/status") return ok(status);
    if (url === "/api/ai-tools/rome-credits") return ok({ credits });
    if (url === "/api/ai-tools/anthropic-compatible-providers") {
      return ok({ providers: [], configured: null });
    }
    return ok({});
  }) as typeof fetch);
}

const SIGNUP_CREDITS: RomeCreditsView = {
  grantedMicros: "10000000",
  balanceMicros: "10000000",
  availableMicros: "10000000",
  enabled: true,
};

describe("AiToolsCard", () => {
  it("offers Rome credits in place of a skip while the account has some left", async () => {
    mockStatus({ claude: { loggedIn: false }, codex: { loggedIn: false } }, SIGNUP_CREDITS);
    const onSubmit = rs.fn();

    render(<AiToolsCard toolUseId="t-credits" onSubmit={onSubmit} />);

    const proceed = await screen.findByRole("button", { name: "Continue with credits" });
    expect(screen.getByText("Start with free Rome credits")).toBeTruthy();
    expect(await screen.findByText("Rome credits")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();

    await userEvent.setup().click(proceed);

    // Credits run Rome the way a sign-in would, so the welcome treats the step
    // as connected.
    expect(onSubmit).toHaveBeenCalledWith(
      "t-credits",
      { connected: true, credits: true },
      "Continued with Rome credits",
    );
    expect(screen.getByText("Using Rome credits")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with credits" })).toBeNull();
  });

  it("advances a connected guardian without waiting on the credits read", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      const url = String(input);
      if (url === "/api/ai-tools/status") {
        return ok({ claude: { loggedIn: true }, codex: { loggedIn: false } });
      }
      // Rome Cloud never answers.
      if (url === "/api/ai-tools/rome-credits") return await new Promise<Response>(() => {});
      return ok({});
    }) as typeof fetch);
    const onSubmit = rs.fn();

    render(<AiToolsCard toolUseId="t-slow-credits" onSubmit={onSubmit} />);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith("t-slow-credits", { connected: true }, "Connected an AI");
  });

  it("falls back to the plain skip once the credits are used up", async () => {
    mockStatus(
      { claude: { loggedIn: false }, codex: { loggedIn: false } },
      { ...SIGNUP_CREDITS, balanceMicros: "-12000", availableMicros: "-12000" },
    );

    render(<AiToolsCard toolUseId="t-used-up" onSubmit={rs.fn()} />);

    expect(await screen.findByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(screen.getByText("Connect Claude or ChatGPT")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with credits" })).toBeNull();
  });

  it("renders a card resolved with credits read-only", () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");

    render(
      <AiToolsCard
        toolUseId="t-resolved-credits"
        result={{ connected: true, credits: true }}
        onSubmit={rs.fn()}
      />,
    );

    expect(screen.getByText("Using Rome credits")).toBeTruthy();
    expect(screen.queryByText("AI connected")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never shows the sign-in options when a provider is already connected", async () => {
    mockStatus({ claude: { loggedIn: true }, codex: { loggedIn: false } });
    const onSubmit = rs.fn();

    render(<AiToolsCard toolUseId="t-1" onSubmit={onSubmit} />);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith("t-1", { connected: true }, "Connected an AI");
    expect(await screen.findByText("AI connected")).toBeTruthy();
    // The panel is what renders the per-provider sign-in controls. Mounting it
    // first and resolving afterwards is the flicker this guards against.
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    expect(screen.queryByText("Connect Claude or ChatGPT")).toBeNull();
  });

  it("offers the panel once the probe reports no provider", async () => {
    mockStatus({ claude: { loggedIn: false }, codex: { loggedIn: false } });
    const onSubmit = rs.fn();

    render(<AiToolsCard toolUseId="t-2" onSubmit={onSubmit} />);

    const skip = await screen.findByRole("button", { name: "Skip for now" });
    expect(screen.getByText("Connect Claude or ChatGPT")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.setup().click(skip);

    expect(onSubmit).toHaveBeenCalledWith("t-2", { skip: true }, "Skipped connecting an AI");
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("lets the chat card own the embedded provider panel width", async () => {
    mockStatus({ claude: { loggedIn: false }, codex: { loggedIn: false } });
    const { container } = render(<AiToolsCard toolUseId="wide-card" onSubmit={rs.fn()} />);

    expect(await screen.findByText("ChatGPT")).toBeTruthy();
    expect(container.querySelector('[data-slot="measure"]')).toBeNull();
    expect(container.querySelector('[data-slot="section"]')).toBeNull();
  });

  it("shows neither the options nor a verdict while the probe is in flight", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      if (String(input) === "/api/ai-tools/status") return await pending;
      return ok({});
    }) as typeof fetch);

    render(<AiToolsCard toolUseId="t-3" onSubmit={rs.fn()} />);

    expect(await screen.findByText("Checking your AI connections…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();

    release(ok({ claude: { loggedIn: false }, codex: { loggedIn: false } }));
    expect(await screen.findByRole("button", { name: "Skip for now" })).toBeTruthy();
  });

  it("renders a resolved card read-only without probing", async () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");
    const onSubmit = rs.fn();

    render(<AiToolsCard toolUseId="t-4" result={{ skip: true }} onSubmit={onSubmit} />);

    expect(screen.getByText("Skipped for now")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders a resolved connected card without probing", async () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");

    render(<AiToolsCard toolUseId="t-5" result={{ connected: true }} onSubmit={rs.fn()} />);

    expect(screen.getByText("AI connected")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
