// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import type { ProviderFailurePart } from "@rome/api-types/chat";
import i18n from "@/i18n";
import { ProviderFailureCard, formatUntil } from "./ProviderFailureCard";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const SIGNED_IN = {
  provider: "anthropic",
  signedIn: { anthropic: true, openai: true, rome_credits: false },
};

type Call = { url: string; method: string; body: unknown };

function mockApi(session: { agentName: string | null } | null = { agentName: "concierge" }) {
  const calls: Call[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/ai-tools/default") return Response.json({ defaultProvider: SIGNED_IN });
    if (url === "/api/chat/sessions/c1" && method === "GET") {
      return session
        ? Response.json({ id: "c1", ...session })
        : new Response(null, { status: 404 });
    }
    return Response.json({ ok: true });
  }) as typeof fetch);
  return calls;
}

function renderCard(part: Partial<ProviderFailurePart>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderFailureCard
        part={{
          type: "provider_failure",
          provider: "anthropic",
          reason: "quota",
          followsDefault: true,
          alternatives: ["openai"],
          chatId: "c1",
          ...part,
        }}
      />
    </QueryClientProvider>,
  );
}

describe("ProviderFailureCard", () => {
  it("makes another provider the default after the confirm and resends in this chat", async () => {
    const calls = mockApi();
    const until = new Date();
    until.setHours(15, 0, 0, 0);
    renderCard({ until: until.toISOString() });
    const time = formatUntil(until.toISOString(), "en");
    expect(screen.getByText(`Claude has reached its usage limit until ${time}.`)).toBeTruthy();
    expect(screen.getByText(`Rome retries at ${time}.`)).toBeTruthy();
    // A usage limit is not fixed by signing in.
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Make ChatGPT the default" }));
    expect(screen.getByText("Make ChatGPT the default?")).toBeTruthy();
    expect(screen.getByText("Ongoing chats switch to ChatGPT on their next reply.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Make default" }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === "PUT")).toMatchObject({
        url: "/api/ai-tools/default",
        body: { provider: "openai", resend: { chatId: "c1", agentName: "concierge" } },
      }),
    );
    expect(await screen.findByText("Sent again.")).toBeTruthy();
  });

  it("takes an exact selection back to following the default, then resends", async () => {
    const calls = mockApi({ agentName: null });
    renderCard({ followsDefault: false, reason: "login" });
    expect(screen.getByText("Claude needs you to sign in again.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Back to following default" }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")).toMatchObject({
        url: "/api/ai-tools/provider-failures/resend",
        body: { chatId: "c1", agentName: "main" },
      }),
    );
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch).toMatchObject({
      url: "/api/chat/sessions/c1/model",
      body: { largeModelSelection: "auto" },
    });
    expect(calls.indexOf(patch!)).toBeLessThan(calls.findIndex((call) => call.method === "POST"));
  });

  it("offers a resend once the failed provider reads as signed in", async () => {
    mockApi();
    renderCard({ reason: "removed", alternatives: [] });
    expect(screen.getByText("Claude is not signed in.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Resend" })).toBeTruthy();
  });
});
