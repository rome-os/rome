// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import { fetchSharedChat } from "@/lib/chat-api";
import SharePage from "./SharePage";

rs.mock("@/lib/chat-api", () => ({ fetchSharedChat: rs.fn() }));
const robots = () => document.head.querySelector('meta[name="robots"]')?.getAttribute("content");

const renderAt = (token: string) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/share/${token}`]}>
          <Routes>
            <Route path="/share/:token" element={<SharePage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  rs.stubGlobal("IntersectionObserver", undefined);
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
  rs.mocked(fetchSharedChat).mockResolvedValue({
    id: "tok",
    title: "Day one",
    snapshot: {
      mainSessionId: "s",
      messages: [
        {
          id: "m1",
          sessionId: "s",
          turnId: "t1",
          role: "assistant",
          content: JSON.stringify([{ type: "text", content: "Day one: walk the Alfama." }]),
          createdAt: "2026-11-10T10:00:00.000Z",
        },
      ],
      traces: {},
    },
    layout: [],
  });
});
afterEach(() => {
  cleanup();
  rs.clearAllMocks();
  rs.unstubAllGlobals();
});

describe("SharePage", () => {
  it("keeps search engines out only while it is mounted", async () => {
    const page = renderAt("tok");
    await screen.findByText("Day one: walk the Alfama.");
    expect(robots()).toBe("noindex, nofollow");
    page.unmount();
    expect(robots()).toBeUndefined();
  });

  it("puts Rome's mark, tagline and a link to learn about Rome in one header", async () => {
    renderAt("tok");
    await screen.findByText("Day one: walk the Alfama.");
    const header = screen.getByRole("banner");
    const mark = within(header).getByRole("link", { name: /^Rome/ });
    expect(mark.getAttribute("href")).toBe("https://romeos.io");
    expect(mark.textContent).toContain("Your personal assistant");
    const learn = within(header).getByRole("link", { name: "Learn about Rome" });
    expect(learn.getAttribute("href")).toBe("https://romeos.io");
    expect(learn.getAttribute("target")).toBe("_blank");
    expect(learn.getAttribute("rel")).toBe("noopener");
    expect(screen.queryByRole("contentinfo")).toBeNull();
  });

  it("shows a shared message without a sender row, since the header names Rome", async () => {
    renderAt("tok");
    await screen.findByText("Day one: walk the Alfama.");
    expect(screen.getAllByText("Rome")).toHaveLength(1);
  });

  it("keeps the speakers in a share of several turns", async () => {
    rs.mocked(fetchSharedChat).mockResolvedValue({
      id: "tok",
      title: "Trip",
      snapshot: {
        mainSessionId: "s",
        messages: [
          {
            id: "u1",
            sessionId: "s",
            turnId: "t1",
            role: "user",
            content: JSON.stringify([{ type: "text", content: "Plan my trip" }]),
            createdAt: "2026-11-10T09:59:00.000Z",
          },
          {
            id: "a1",
            sessionId: "s",
            turnId: "t1",
            role: "assistant",
            content: JSON.stringify([{ type: "text", content: "Day one: walk the Alfama." }]),
            createdAt: "2026-11-10T10:00:00.000Z",
          },
        ],
        traces: {},
      },
      layout: [],
    });
    renderAt("tok");
    await screen.findByText("Day one: walk the Alfama.");
    // The header's "Rome", and the agent's sender row.
    expect(screen.getAllByText("Rome")).toHaveLength(2);
  });

  it("keeps the branding and noindex on an unavailable link", async () => {
    rs.mocked(fetchSharedChat).mockResolvedValue(null);
    renderAt("gone");
    await screen.findByText("This shared chat is unavailable");
    expect(robots()).toBe("noindex, nofollow");
    expect(screen.getByRole("link", { name: "Learn about Rome" })).toBeTruthy();
  });
});
