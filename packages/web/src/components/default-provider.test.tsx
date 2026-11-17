// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import i18n from "@/i18n";
import { DefaultProviderControl } from "@/components/ai-tools-panel";
import type { DefaultProviderState } from "@/hooks/use-default-provider";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

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

  it("tells the guardian that credits as the default pay for every ChatGPT run", async () => {
    const credits = state({ anthropic: true, openai: true, rome_credits: true });
    renderWithQueries(<DefaultProviderControl provider="rome_credits" state={credits} />);
    await userEvent.click(screen.getByRole("button", { name: "Set as default" }));
    expect(screen.getByText("Make Rome credits the default?")).toBeTruthy();
    expect(
      screen.getByText("Ongoing chats switch to Rome credits on their next reply."),
    ).toBeTruthy();
    expect(
      screen.getByText("While Rome credits are the default, every ChatGPT run uses Rome credits."),
    ).toBeTruthy();
  });
});
