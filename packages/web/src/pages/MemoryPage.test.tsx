// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { MemoryFolderPanel } from "./MemoryPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("Memory home", () => {
  it("links to the Dream page, which is off the launcher", () => {
    rs.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <MemoryFolderPanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const link = screen.getByRole("link", { name: /See what changed/ });
    expect(link.getAttribute("href")).toBe("/apps/dream");
    expect(screen.getByRole("heading", { name: "Dream" })).toBeTruthy();
  });
});
