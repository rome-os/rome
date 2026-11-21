// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import { parseEntries } from "./parse-entries";
import { renderFlatEntries } from "./render";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("a refused turn's message", () => {
  it("shows the provider failure card in place of the error written beside it", () => {
    rs.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));
    const stored = JSON.stringify([
      {
        type: "error",
        error: "Selected model provider is unavailable: Claude is not signed in",
        code: "model_provider_unavailable",
        provider: "anthropic",
        reason: "not_logged_in",
      },
      {
        type: "provider_failure",
        provider: "anthropic",
        reason: "removed",
        followsDefault: true,
        alternatives: [],
        chatId: "c1",
      },
    ]);
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ThemeProvider>
            {renderFlatEntries(parseEntries(stored), { sessionId: "c1" })}
          </ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(container.querySelector("[data-provider-failure]")).not.toBeNull();
    expect(container.textContent).not.toContain("Go to sign in");
  });
});
