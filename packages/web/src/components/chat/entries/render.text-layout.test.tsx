// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import type { ChatEntry } from "@/lib/chat-types";
import { renderFlatEntries, type RenderEntryOptions } from "./render";

afterEach(cleanup);

const SHORT = "Any time.";
const LONG = "## Plan\n\nDay one in Kyoto.";

function renderText(content: string, options: RenderEntryOptions = {}) {
  const blocks: ChatEntry[] = [{ type: "text", content }];
  render(
    <MemoryRouter>
      <ThemeProvider>{renderFlatEntries(blocks, options)}</ThemeProvider>
    </MemoryRouter>,
  );
}

// The element that frames the text: the bubble in the transcript, the
// wrapper when the text renders bare.
const frameOf = (text: string) =>
  screen.getByText(text).closest(".rome-markdown")?.parentElement as HTMLElement;

describe("a common chat's agent text", () => {
  it("keeps a short answer in a filled bubble in the transcript", () => {
    renderText(SHORT, { transcript: { live: false } });

    const classes = frameOf(SHORT).className.split(/\s+/);
    expect(classes).toContain("bg-surface-muted");
    expect(classes).not.toContain("rome-markdown-document");
  });

  it("draws a long answer in the transcript as a document at the reading width", () => {
    renderText(LONG, { transcript: { live: false } });

    const classes = frameOf("Day one in Kyoto.").className.split(/\s+/);
    expect(classes).toContain("rome-markdown-document");
    expect(classes).toContain("max-w-2xl");
    expect(classes).not.toContain("bg-surface-muted");
  });

  it("gives a long bare answer the document rhythm and width, and leaves a short one bare", () => {
    renderText(LONG);
    expect(frameOf("Day one in Kyoto.").className.split(/\s+/)).toEqual(
      expect.arrayContaining(["rome-markdown-document", "max-w-2xl"]),
    );
    cleanup();

    renderText(SHORT);
    expect(frameOf(SHORT).className).not.toContain("rome-markdown-document");
  });

  it("keeps compact text out of the document layout", () => {
    renderText(LONG, { transcript: { live: false }, compact: true });

    expect(document.querySelector(".rome-markdown-document")).toBeNull();
  });
});
