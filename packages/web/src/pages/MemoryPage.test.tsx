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

  it("aligns Dream and Backup headings and backup notes to the 16px card inset in muted aux type", () => {
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

    const dream = screen.getByRole("heading", { level: 3, name: "Dream" });
    const backup = screen.getByRole("heading", { level: 3, name: "Backup" });
    for (const heading of [dream, backup]) {
      expect(heading.className).toContain("px-4");
      expect(heading.className).toContain("text-aux");
      expect(heading.className).toContain("text-muted-foreground");
      expect(heading.className).not.toContain("px-1");
      expect(heading.className).not.toContain("text-section");
      expect(heading.className).not.toContain("text-foreground");
      expect(heading.parentElement?.className).toContain("gap-2");
    }

    const hint = screen.getByText(/Keep a private, versioned copy on GitHub/i);
    const deviceNote = screen.getByText(/Channel links stay on this device/i);
    const footer = hint.parentElement;
    expect(footer).toBe(deviceNote.parentElement);
    expect(footer?.className).toContain("px-4");
    expect(footer?.className).toContain("text-aux");
    expect(footer?.className).toContain("text-muted-foreground");
    expect(footer?.className).not.toContain("px-1");
    expect(footer?.className).not.toContain("text-subtle-foreground");
  });
});
