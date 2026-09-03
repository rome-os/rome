// @rstest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
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

function mockStatus(status: { claude: { loggedIn: boolean }; codex: { loggedIn: boolean } }) {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    const url = String(input);
    if (url === "/api/ai-tools/status") return ok(status);
    if (url === "/api/ai-tools/anthropic-compatible-providers") {
      return ok({ providers: [], configured: null });
    }
    return ok({});
  }) as typeof fetch);
}

describe("AiToolsCard", () => {
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
