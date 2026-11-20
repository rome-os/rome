// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import type { ProviderFailurePart } from "@rome/api-types/chat";
import i18n from "@/i18n";
import { ProviderFailureCard, failureCardKind, formatUntil } from "./ProviderFailureCard";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

type Call = { url: string; method: string; body: unknown };

function mockApi() {
  const calls: Call[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ ok: true });
  }) as typeof fetch);
  return calls;
}

function renderCard(part: Partial<ProviderFailurePart>, onSettled?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderFailureCard
        messageId="m1"
        onSettled={onSettled}
        part={{
          type: "provider_failure",
          provider: "openai",
          reason: "quota",
          card: "wait",
          followsDefault: true,
          alternatives: ["anthropic"],
          chatId: "c1",
          ...part,
        }}
      />
    </QueryClientProvider>,
  );
}

describe("formatUntil", () => {
  it("names today, tomorrow, or the date", () => {
    const now = new Date(2026, 10, 20, 9, 0);
    expect(formatUntil(new Date(2026, 10, 20, 15, 54).toISOString(), "en", now).day).toBe("today");
    expect(formatUntil(new Date(2026, 10, 21, 3, 54).toISOString(), "en", now).day).toBe(
      "tomorrow",
    );
    expect(formatUntil(new Date(2026, 10, 24, 3, 54).toISOString(), "en", now)).toMatchObject({
      day: "date",
      date: "Nov 24",
    });
  });
});

describe("ProviderFailureCard", () => {
  it("waits out a usage limit and switches this chat only, unless also made default", async () => {
    const calls = mockApi();
    const settled = rs.fn();
    const until = new Date();
    until.setHours(14, 20, 0, 0);
    renderCard({ until: until.toISOString() }, settled);
    const { time } = formatUntil(until.toISOString(), "en");
    expect(screen.getByText(`ChatGPT quota used up, continues today at ${time}`)).toBeTruthy();
    // A usage limit ends by itself, so nothing asks to log in.
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
    const makeDefault = screen.getByRole("checkbox", { name: "Also make default" });
    expect(makeDefault.getAttribute("aria-checked")).toBe("false");

    await userEvent.click(makeDefault);
    await userEvent.click(screen.getByRole("button", { name: "Switch to Claude" }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")).toMatchObject({
        url: "/api/ai-tools/provider-failures/m1/switch",
        body: { kind: "provider", provider: "anthropic", makeDefault: true },
      }),
    );
    expect(await screen.findByText("Switched to Claude, continued")).toBeTruthy();
    expect(settled).toHaveBeenCalled();
  });

  it("asks to log in again, with a switch and the provider's detail behind Details", async () => {
    mockApi();
    renderCard({
      reason: "login",
      card: "account",
      detail: "401 Unauthorized",
    });
    expect(screen.getByText("ChatGPT needs you to log in again")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch to Claude" })).toBeTruthy();
    expect(screen.queryByText("401 Unauthorized")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("401 Unauthorized")).toBeTruthy();
  });

  it("offers Rome credits when no account is logged in and credits are left", async () => {
    const calls = mockApi();
    renderCard({
      provider: "anthropic",
      reason: "removed",
      card: "account",
      alternatives: [],
      credits: true,
    });
    expect(screen.getByText("Claude is not logged in")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use Rome credits" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        kind: "provider",
        provider: "rome_credits",
        makeDefault: false,
      }),
    );
  });

  it("moves to the replacement model, with no make-default choice", async () => {
    const calls = mockApi();
    renderCard({
      reason: "model_unavailable",
      card: "model",
      model: "gpt-6-astra",
      replacement: { selection: "gpt-6-1-sol", model: "gpt-6.1-sol" },
      followsDefault: false,
    });
    expect(screen.getByText("GPT-6 Astra is unavailable")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch to Claude" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Switch to GPT-6.1 Sol" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        kind: "model",
        selection: "gpt-6-1-sol",
      }),
    );
    expect(await screen.findByText("Switched to GPT-6.1 Sol, continued")).toBeTruthy();
  });

  it("reads as one line once settled, with no buttons", () => {
    mockApi();
    const { container, rerender } = renderCard({
      resolved: { at: "2026-08-08T09:22:00.000Z", by: "switched", provider: "anthropic" },
    });
    expect(screen.getByText("Switched to Claude, continued")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("[data-provider-failure]")).toBeNull();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ProviderFailureCard
          messageId="m1"
          part={{
            type: "provider_failure",
            provider: "openai",
            reason: "temporary",
            followsDefault: true,
            alternatives: [],
            chatId: "c1",
            resolved: { at: "2026-08-08T09:22:00.000Z", by: "recovered", continued: true },
          }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Recovered, continued")).toBeTruthy();
  });

  it("says when a switch failed", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "No open card" }, { status: 409 }),
    );
    renderCard({});
    await userEvent.click(screen.getByRole("button", { name: "Switch to Claude" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not switch");
  });
});

describe("failureCardKind", () => {
  it("reads a card written before `card` existed from its reason", () => {
    expect(failureCardKind({ reason: "quota" })).toBe("wait");
    expect(failureCardKind({ reason: "login" })).toBe("account");
    expect(failureCardKind({ reason: "removed" })).toBe("account");
    expect(failureCardKind({ reason: "model_unavailable" })).toBe("model");
    expect(failureCardKind({ reason: "login", card: "wait" })).toBe("wait");
  });
});
