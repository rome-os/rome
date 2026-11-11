// @rstest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import type { ChatEntry } from "@/lib/chat-types";
import { parseEntries } from "./parse-entries";
import { renderFlatEntries } from "./render";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("widget entries", () => {
  it("mounts a stored widget's component from its own app, as on every load", () => {
    const fetch = rs.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));
    const stored = JSON.stringify([
      {
        type: "widget",
        toolUseId: "w1",
        appId: "meals",
        componentId: "today",
        props: { date: "2026-11-11" },
        text: "Showing today's meals as a card.",
      },
    ]);
    const blocks: ChatEntry[] = parseEntries(stored);

    const { container } = render(
      <MemoryRouter>
        <ThemeProvider>{renderFlatEntries(blocks, { sessionId: "s1" })}</ThemeProvider>
      </MemoryRouter>,
    );

    expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/apps/meals/manifest");
    expect(container.querySelector("[data-chat-pending-card]")).toBeNull();
  });
});
