import { readFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";

const dashboardCss = readFileSync(new URL("../../globals.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const sharedMarkdownCss = readFileSync(
  new URL("../../../../ui/src/markdown.css", import.meta.url),
  "utf8",
);
const normalizedDashboardCss = dashboardCss.replace(/\s+/g, " ");

describe("chat code block styles", () => {
  it("keeps the dashboard-only markup contract out of the shared Markdown stylesheet", () => {
    expect(sharedMarkdownCss).not.toContain("data-chat-code-block");
  });

  it("preserves the wrapper rhythm and hides the duplicate card label", () => {
    expect(normalizedDashboardCss).toContain(
      '.rome-markdown [data-chat-code-block="code"] { margin-block: var(--markdown-code-block-space-block); }',
    );
    expect(normalizedDashboardCss).toContain(
      '.rome-markdown [data-chat-code-block="mermaid"] { margin-block: var(--markdown-media-space-block); }',
    );
    expect(normalizedDashboardCss).toContain(
      '.rome-markdown > [data-chat-code-block] + :not([data-streamdown^="heading-"]) { margin-block-start: 0; }',
    );
    expect(normalizedDashboardCss).toContain(
      '[data-chat-code-block] :is( [data-streamdown="code-block-header"], [data-streamdown="mermaid-block"] > :first-child ) { display: none;',
    );
  });

  // The wrapper is the card. The nested Streamdown card hands its frame over
  // and goes flush, so the toggle and the content share one outline.
  it("flattens the nested card into the wrapper", () => {
    expect(normalizedDashboardCss).toContain(
      '[data-chat-code-block] :is([data-streamdown="code-block"], [data-streamdown="mermaid-block"]) { margin-block: 0; border: 0; border-radius: 0; background-color: transparent; }',
    );
    expect(normalizedDashboardCss).toContain(
      '[data-chat-code-block] [data-streamdown="mermaid-block"] > :last-child { border: 0; border-radius: 0; }',
    );
  });
});
