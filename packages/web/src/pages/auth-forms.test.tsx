// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import LoginPage from "./LoginPage";

// These forms run on the TanStack Form + Zod foundation. The behavior under test
// is purely client-side: invalid input must surface a field error and must never
// reach the network. We assert on the rendered error text and on fetch not being
// called — the observable contract, independent of any backend.

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderPage(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LoginPage validation", () => {
  it("keeps the standalone auth surface inside both safe-area edges", () => {
    renderPage(<LoginPage />);

    const main = screen.getByRole("main");
    expect(main.className).toContain("pt-safe");
    expect(main.className).toContain("pb-safe");
    expect(
      screen.getByRole("combobox", { name: "Language" }).parentElement?.parentElement?.className,
    ).toContain("top-[calc(1rem+var(--rome-safe-area-top))]");
  });

  it("shows required errors and does not submit when both fields are empty", async () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    renderPage(<LoginPage />);

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Username is required.")).toBeTruthy();
    expect(screen.getByText("Password is required.")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clears a field error live as the user types after a failed submit", async () => {
    const user = userEvent.setup();
    renderPage(<LoginPage />);

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Username is required.")).toBeTruthy();

    await user.type(screen.getByLabelText("Username"), "guardian");

    expect(screen.queryByText("Username is required.")).toBeNull();
    expect(screen.getByText("Password is required.")).toBeTruthy();
  });
});
