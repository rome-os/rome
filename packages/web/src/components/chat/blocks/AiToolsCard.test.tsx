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
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    const url = String(input);
    if (url === "/api/ai-tools/status") return ok(status);
    if (url === "/api/ai-tools/anthropic-compatible-providers") {
      return ok({ providers: [], configured: null });
    }
    return ok({});
  }) as typeof fetch);
}

describe("AiToolsCard", () => {
  it("resolves with { connected } as soon as the status probe reports a provider logged in", async () => {
    mockStatus({ claude: { loggedIn: false }, codex: { loggedIn: true } });
    const onSubmit = rs.fn();

    render(<AiToolsCard toolUseId="t-1" onSubmit={onSubmit} />);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith("t-1", { connected: true }, "Connected an AI");
    expect(await screen.findByText("Connected")).toBeTruthy();
  });

  it("stays open while no provider is logged in, and resolves with { skip } on skip", async () => {
    mockStatus({ claude: { loggedIn: false }, codex: { loggedIn: false } });
    const onSubmit = rs.fn();

    render(<AiToolsCard toolUseId="t-2" onSubmit={onSubmit} />);

    const skip = await screen.findByRole("button", { name: "Skip for now" });
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.setup().click(skip);

    expect(onSubmit).toHaveBeenCalledWith("t-2", { skip: true }, "Skipped connecting an AI");
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("renders a resolved card read-only without probing", async () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");
    const onSubmit = rs.fn();

    render(<AiToolsCard toolUseId="t-3" result={{ skip: true }} onSubmit={onSubmit} />);

    expect(screen.getByText("Skipped for now")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
