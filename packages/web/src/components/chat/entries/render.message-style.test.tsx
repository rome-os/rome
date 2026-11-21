// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Markdown from "@/components/markdown";
import { ThemeProvider } from "@/hooks/use-theme";
import type { ChatEntry } from "@/lib/chat-types";
import { renderFlatEntries, type RenderEntryOptions } from "./render";

afterEach(cleanup);

const ANSWER = "## Plan\n\n**Day one:** Kyoto.";

function renderAnswer(options: RenderEntryOptions = {}) {
  const blocks: ChatEntry[] = [{ type: "text", content: ANSWER }];
  render(
    <MemoryRouter>
      <ThemeProvider>{renderFlatEntries(blocks, options)}</ThemeProvider>
    </MemoryRouter>,
  );
  return screen.getByText("Plan").closest(".rome-markdown");
}

describe("message text style", () => {
  it("sets a bare final answer in the message style, with no bubble around it", () => {
    const root = renderAnswer();

    expect(root?.classList).toContain("rome-markdown-message");
    expect(root?.closest(".rounded-16")).toBeNull();
  });

  it("sets an answer in a transcript bubble in the same message style", () => {
    const root = renderAnswer({ transcript: { live: false } });

    expect(root?.classList).toContain("rome-markdown-message");
    expect(root?.closest(".rounded-16")).not.toBeNull();
  });

  it("leaves Markdown outside a message in the kit's default style", () => {
    render(
      <MemoryRouter>
        <ThemeProvider>
          <Markdown>{ANSWER}</Markdown>
        </ThemeProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText("Plan").closest(".rome-markdown")?.classList).not.toContain(
      "rome-markdown-message",
    );
  });
});
