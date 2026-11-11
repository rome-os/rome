// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import { fetchSharedChat } from "@/lib/chat-api";
import SharePage from "./SharePage";

rs.mock("@/lib/chat-api", () => ({ fetchSharedChat: rs.fn() }));
const robots = () => document.head.querySelector('meta[name="robots"]')?.getAttribute("content");

const renderAt = (token: string) =>
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[`/share/${token}`]}>
        <Routes>
          <Route path="/share/:token" element={<SharePage />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
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

  it("is branded with Rome's mark and a link to learn about Rome, in a new tab", async () => {
    renderAt("tok");
    await screen.findByText("Day one: walk the Alfama.");
    const mark = screen.getByRole("link", { name: "Rome" });
    expect(mark.getAttribute("href")).toBe("https://romeos.io");
    expect(screen.getByText("Made with Rome")).toBeTruthy();
    const learn = screen.getByRole("link", { name: "Learn about Rome" });
    expect(learn.getAttribute("href")).toBe("https://romeos.io");
    expect(learn.getAttribute("target")).toBe("_blank");
    expect(learn.getAttribute("rel")).toBe("noopener");
  });

  it("keeps the branding and noindex on an unavailable link", async () => {
    rs.mocked(fetchSharedChat).mockResolvedValue(null);
    renderAt("gone");
    await screen.findByText("This shared chat is unavailable");
    expect(robots()).toBe("noindex, nofollow");
    expect(screen.getByRole("link", { name: "Rome" })).toBeTruthy();
    expect(screen.getByText("Made with Rome")).toBeTruthy();
  });
});
