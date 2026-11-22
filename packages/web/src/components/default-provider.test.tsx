// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { DefaultProviderControl, logoutOutcome } from "@/components/ai-tools-panel";
import type { DefaultModelProvider, DefaultProviderState } from "@/hooks/use-default-provider";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderWithQueries(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const state = (signedIn: DefaultProviderState["signedIn"]): DefaultProviderState => ({
  provider: "anthropic",
  signedIn,
});

describe("DefaultProviderControl", () => {
  it("marks the default and offers the other signed-in providers", () => {
    const both = state({ anthropic: true, openai: true, rome_credits: false });
    renderWithQueries(
      <>
        <DefaultProviderControl provider="anthropic" state={both} />
        <DefaultProviderControl provider="openai" state={both} />
        <DefaultProviderControl provider="rome_credits" state={both} />
      </>,
    );
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Set as default" })).toHaveLength(1);
  });

  it("shows only the badge while one provider is signed in", () => {
    const one = state({ anthropic: true, openai: false, rome_credits: false });
    renderWithQueries(<DefaultProviderControl provider="anthropic" state={one} />);
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never offers Rome credits as the default", () => {
    const credits = state({ anthropic: true, openai: true, rome_credits: true });
    renderWithQueries(<DefaultProviderControl provider="rome_credits" state={credits} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

type Put = { provider: DefaultModelProvider; moveExisting: boolean };

function mockDefault(followingChats: number) {
  const puts: Put[] = [];
  const current = {
    ...state({ anthropic: true, openai: true, rome_credits: false }),
    followingChats,
    romeCreditsUsable: false,
  };
  rs.spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
    if (init?.method === "PUT") puts.push(JSON.parse(String(init.body)) as Put);
    return Response.json({ defaultProvider: current });
  }) as typeof fetch);
  renderWithQueries(<DefaultProviderControl provider="openai" state={current} />);
  return puts;
}

describe("the change-default dialog", () => {
  it("asks whether existing chats move, checked by default", async () => {
    const puts = mockDefault(3);
    await userEvent.click(screen.getByRole("button", { name: "Set as default" }));
    expect(screen.getByText("Ongoing chats switch to ChatGPT on their next reply.")).toBeTruthy();
    const move = await screen.findByRole("checkbox", { name: "Move existing chats too" });
    expect(move.getAttribute("aria-checked")).toBe("true");

    await userEvent.click(move);
    expect(
      screen.getByText("New chats use ChatGPT. Ongoing chats stay on the provider they run on."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(puts).toEqual([{ provider: "openai", moveExisting: false }]));
  });

  it("does not ask while no chat follows the default", async () => {
    const puts = mockDefault(0);
    await userEvent.click(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() => expect(puts).toHaveLength(0));
    expect(screen.queryByRole("checkbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(puts).toEqual([{ provider: "openai", moveExisting: true }]));
  });
});

describe("logoutOutcome", () => {
  const names = (provider: DefaultModelProvider) =>
    provider === "anthropic" ? "Claude" : provider === "openai" ? "ChatGPT" : "Rome credits";
  const t = i18n.getFixedT("en", "settings");
  const both = (provider: DefaultModelProvider): DefaultProviderState => ({
    provider,
    signedIn: { anthropic: true, openai: true, rome_credits: false },
  });

  it("hands the default to the other account when the default logs out", () => {
    expect(logoutOutcome("claude", both("anthropic"), names, t)).toEqual({
      text: "ChatGPT becomes the default. Chats move to it on their next reply.",
      asksToMove: false,
    });
    expect(logoutOutcome("claude", both("openai"), names, t)).toBeNull();
  });

  it("asks Move existing chats too while chats would move, and says where they stay unchecked", () => {
    const busy = { ...both("anthropic"), followingChats: 3 };
    expect(logoutOutcome("claude", busy, names, t)).toMatchObject({ asksToMove: true });
    expect(logoutOutcome("claude", busy, names, t, { moveExisting: false })?.text).toBe(
      "ChatGPT becomes the default for new chats. Existing chats stay on Claude and wait until you log in again.",
    );
  });

  it("still hands the default to an expired account, and warns that its login expired", () => {
    expect(logoutOutcome("claude", both("anthropic"), names, t, { otherExpired: true })?.text).toBe(
      "ChatGPT becomes the default. Chats move to it on their next reply. Its login has expired: log in to ChatGPT again after you log out.",
    );
  });

  it("makes Rome credits the default when the last account logs out", () => {
    const only: DefaultProviderState = {
      provider: "openai",
      signedIn: { anthropic: false, openai: true, rome_credits: false },
      followingChats: 2,
    };
    expect(logoutOutcome("codex", { ...only, romeCreditsUsable: true }, names, t)).toEqual({
      text: "Rome credits become the default. Chats move to them on their next reply.",
      asksToMove: true,
    });
    expect(logoutOutcome("codex", only, names, t)).toEqual({
      text: "Chats pause until you log in again.",
      asksToMove: false,
    });
  });
});
