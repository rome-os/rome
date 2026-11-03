// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { LinkMyAccount } from "./link-code";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderButton() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LinkMyAccount />
    </QueryClientProvider>,
  );
}

describe("LinkMyAccount", () => {
  it("asks for a new code each time it opens and shows it", async () => {
    let n = 0;
    const fetch = rs.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { code: `ROME-AAAAAAA${++n}`, expiresAt: Date.now() + 600_000 },
        {
          status: 201,
        },
      ),
    );
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Link my account" }));
    await screen.findByText("ROME-AAAAAAA1");
    expect(fetch).toHaveBeenCalledWith(
      "/api/people/link-code",
      expect.objectContaining({ method: "POST" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Link my account" }));
    await screen.findByText("ROME-AAAAAAA2");
  });

  it("says so when no code can be had", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "Guardian authentication required" }, { status: 403 }),
    );
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Link my account" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Guardian authentication required");
  });
});
