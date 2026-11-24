// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import type { ProviderFailurePart } from "@rome/api-types/chat";
import i18n from "@/i18n";
import { CHAT_SESSIONS_CHANGED_EVENT } from "@/lib/session-events";
import { ProviderFailureCard, failureCardKind, formatUntil } from "./ProviderFailureCard";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

type Call = { url: string; method: string; body: unknown };

/** `followingChats`: how many chats a change of the default would move. */
function mockApi(followingChats = 2) {
  const calls: Call[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/api/ai-tools/default")) {
      return Response.json({
        defaultProvider: {
          provider: "openai",
          signedIn: { anthropic: true, openai: true, rome_credits: false },
          followingChats,
        },
      });
    }
    if (url.endsWith("/rome-credits")) {
      return Response.json({
        credits: {
          grantedMicros: "2000000",
          balanceMicros: "2000000",
          availableMicros: "2000000",
          enabled: true,
          models: [],
        },
      });
    }
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
    const until = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    renderCard({ until, continues: true }, settled);
    const { day, time } = formatUntil(until, "en");
    // The status line carries the reset time; the reason under it does not.
    expect(
      screen.getByText(
        day === "today"
          ? `Paused · continues after ${time}`
          : `Paused · continues tomorrow after ${time}`,
      ),
    ).toBeTruthy();
    // Before the reset nothing offers to continue: the usage-limit sweep does.
    // Retry is on every card, though.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("ChatGPT quota used up")).toBeTruthy();
    expect(
      document.querySelector("[data-provider-failure]")?.className.includes("border-l-warning"),
    ).toBe(true);
    // A usage limit ends by itself, so nothing asks to log in.
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
    // The card itself carries no default choice: its switch asks in a dialog.
    expect(screen.queryByRole("checkbox", { name: "Also make default" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Switch to Claude" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Switch to Claude?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "This chat continues on Claude, and the stopped turn picks up again.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Only this chat switches. Other chats stay where they are."),
    ).toBeTruthy();
    const makeDefault = within(dialog).getByRole("checkbox", { name: "Also make default" });
    expect(makeDefault.getAttribute("aria-checked")).toBe("false");
    expect(within(dialog).queryByRole("checkbox", { name: "Move existing chats too" })).toBeNull();
    await userEvent.click(makeDefault);
    // Making it the default asks what Settings asks, moving the other chats by default.
    const moveExisting = within(dialog).getByRole("checkbox", { name: "Move existing chats too" });
    expect(moveExisting.getAttribute("aria-checked")).toBe("true");
    expect(
      within(dialog).getByText("Other chats switch to Claude on their next reply."),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch" }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")).toMatchObject({
        url: "/api/ai-tools/provider-failures/m1/switch",
        body: { kind: "provider", provider: "anthropic", makeDefault: true, moveExisting: true },
      }),
    );
    expect(await screen.findByText("Switched to Claude, continued")).toBeTruthy();
    expect(settled).toHaveBeenCalled();
  });

  it("makes it the default and leaves the other chats where they are", async () => {
    const calls = mockApi();
    renderCard({});
    await userEvent.click(screen.getByRole("button", { name: "Switch to Claude" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Also make default" }));
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: "Move existing chats too" }),
    );
    expect(
      within(dialog).queryByText("Other chats switch to Claude on their next reply."),
    ).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        kind: "provider",
        provider: "anthropic",
        makeDefault: true,
        moveExisting: false,
      }),
    );
  });

  it("asks no Move existing chats too, as Settings does not, when no other chat would move", async () => {
    const calls = mockApi(0);
    renderCard({});
    await userEvent.click(screen.getByRole("button", { name: "Switch to Claude" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Also make default" }));
    expect(within(dialog).queryByRole("checkbox", { name: "Move existing chats too" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        kind: "provider",
        provider: "anthropic",
        makeDefault: true,
        moveExisting: true,
      }),
    );
  });

  it("asks to log in again, with a switch and the provider's detail behind Details", async () => {
    mockApi();
    renderCard({
      reason: "login",
      card: "account",
      detail: "401 Unauthorized",
    });
    expect(screen.getByText("Needs you")).toBeTruthy();
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
    const dialog = await screen.findByRole("dialog");
    // The balance, and no choice of chats: Rome credits run every chat.
    expect(
      await within(dialog).findByText(
        "Every chat runs on Rome credits ($2.00 left), and the stopped turn picks up again.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("checkbox", { name: "Also make default" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        kind: "provider",
        provider: "rome_credits",
        makeDefault: true,
        moveExisting: true,
      }),
    );
  });

  it("offers Continue once a usage limit's reset time has passed", async () => {
    const calls = mockApi();
    const settled = rs.fn();
    renderCard({ until: new Date(Date.now() - 60_000).toISOString() }, settled);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")).toMatchObject({
        url: "/api/ai-tools/provider-failures/m1/continue",
      }),
    );
    expect(await screen.findByText("Recovered, continued")).toBeTruthy();
    expect(settled).toHaveBeenCalled();
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
    expect(screen.getByText("Model unavailable")).toBeTruthy();
    expect(screen.getByText("GPT-6 Astra is unavailable")).toBeTruthy();
    // A model change waits on nobody: no accent.
    expect(
      document.querySelector("[data-provider-failure]")?.className.includes("border-l-warning"),
    ).toBe(false);
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

  it("makes the open chat read itself again after a switch, so its pin shows", async () => {
    mockApi();
    const changed = rs.fn();
    window.addEventListener(CHAT_SESSIONS_CHANGED_EVENT, changed);
    try {
      renderCard({
        reason: "model_unavailable",
        card: "model",
        model: "gpt-6-astra",
        replacement: { selection: "gpt-6-1-sol", model: "gpt-6.1-sol" },
        followsDefault: false,
      });
      await userEvent.click(screen.getByRole("button", { name: "Switch to GPT-6.1 Sol" }));
      await waitFor(() => expect(changed).toHaveBeenCalled());
    } finally {
      window.removeEventListener(CHAT_SESSIONS_CHANGED_EVENT, changed);
    }
  });

  it("reads as one line once settled, with no buttons", () => {
    mockApi();
    const { container, rerender } = renderCard({
      resolved: { at: "2026-08-08T09:22:00.000Z", by: "switched", provider: "anthropic" },
    });
    expect(screen.getByText("Switched to Claude, continued")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/^Paused/)).toBeNull();
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
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not switch");
  });
});

describe("cardStatus", () => {
  it("promises nothing for a failure no retry is coming for, and offers Retry", async () => {
    const calls = mockApi();
    renderCard({ reason: "temporary", card: "wait" });
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("ChatGPT is unavailable for now")).toBeTruthy();
    expect(screen.queryByText(/tries again/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")).toMatchObject({
        url: "/api/ai-tools/provider-failures/m1/continue",
      }),
    );
    expect(await screen.findByText("Recovered, continued")).toBeTruthy();
  });

  it("says a quota pauses until its reset where Rome will not continue by itself", () => {
    mockApi();
    const until = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    renderCard({ until });
    const { day, time } = formatUntil(until, "en");
    expect(
      screen.getByText(day === "today" ? `Paused until ${time}` : `Paused until tomorrow ${time}`),
    ).toBeTruthy();
    expect(screen.queryByText(/continues after/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

describe("a card for used-up Rome credits", () => {
  it("offers Log in, the way on with no account and no balance left", async () => {
    mockApi();
    renderCard({
      provider: "rome_credits",
      reason: "credits_used_up",
      card: "account",
      alternatives: [],
    });
    expect(screen.getByText("Rome credits are used up")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use Rome credits" })).toBeNull();
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

describe("Retry is on every card, and a stale option refreshes the card", () => {
  it("offers Retry on an account card beside Log in, and runs the stopped turn", async () => {
    const calls = mockApi();
    renderCard({ reason: "login", card: "account", alternatives: [] });
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.url).toBe(
        "/api/ai-tools/provider-failures/m1/continue",
      ),
    );
  });

  it("offers Retry on a model card beside its switch", () => {
    mockApi();
    renderCard({
      reason: "model_unavailable",
      card: "model",
      alternatives: [],
      replacement: { selection: "gpt-5-6-terra", model: "gpt-5.6-terra" },
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("an option that no longer works reads the chat again, where a fresh card waits", async () => {
    const calls: Call[] = [];
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: undefined });
      if (String(input).endsWith("/switch")) return Response.json({ ok: true, refreshed: true });
      return Response.json({
        defaultProvider: {
          provider: "openai",
          signedIn: { anthropic: true, openai: true, rome_credits: false },
          followingChats: 1,
        },
      });
    }) as typeof fetch);
    const settled = rs.fn();
    renderCard({ reason: "temporary" }, settled);
    await userEvent.click(screen.getByRole("button", { name: "Switch to Claude" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(settled).toHaveBeenCalled());
    expect(screen.queryByText("Switched to Claude, continued")).toBeNull();
  });

  it("asks Move existing chats too only while another chat would move", async () => {
    mockApi(1);
    renderCard({});
    await userEvent.click(screen.getByRole("button", { name: "Switch to Claude" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Also make default" }));
    // The one chat that follows the default is this one, which moves anyway.
    expect(within(dialog).queryByRole("checkbox", { name: "Move existing chats too" })).toBeNull();
  });
});
