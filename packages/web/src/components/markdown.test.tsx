// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readMarkdownMermaidTheme } from "@rome-os/ui/markdown";
import { ThemeProvider } from "../hooks/use-theme";
import Markdown, { getBuiltinMermaidTheme } from "./markdown";

afterEach(cleanup);

function renderMd(md: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <Markdown>{md}</Markdown>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

// The renderer itself — prose, link safety, code/math/mermaid routing — is
// pinned by `@rome-os/ui`'s own suite. What is dashboard-owned, and tested
// here, is the two things the wrapper adds: react-router navigation for in-app
// hrefs, and the explicit Mermaid palette per theme × mode.
describe("Markdown (dashboard wrapper)", () => {
  it("keeps the rome-markdown root the live-caret CSS hook targets", () => {
    const { container } = renderMd("hello");
    expect(container.querySelector(".rome-markdown")).not.toBeNull();
  });

  it("routes internal links through react-router and opens external ones in a new tab", () => {
    renderMd("[docs](/docs) and [site](https://example.com)");
    const internal = screen.getByRole("link", { name: "docs" }) as HTMLAnchorElement;
    expect(internal.getAttribute("href")).toBe("/docs");
    expect(internal.target).toBe("");
    const external = screen.getByRole("link", { name: "site" }) as HTMLAnchorElement;
    expect(external.getAttribute("href")).toContain("example.com");
    expect(external.target).toBe("_blank");
    expect(external.rel).toContain("noopener");
  });

  it.each([
    ["ember", "light", "#fdfcf9", "#1a130f", "#8a7868"],
    ["ember", "dark", "#14110f", "#f4f3ef", "#b0a294"],
    ["ash", "light", "#fefdfb", "#1a130f", "#7a6857"],
    ["ash", "dark", "#14110f", "#f4f3ef", "#b0a294"],
    ["slate", "light", "#ffffff", "#0a0a0a", "#737373"],
    ["slate", "dark", "#121212", "#fafafa", "#a1a1a1"],
    ["sky", "light", "#fdfdfe", "#131416", "#626366"],
    ["sky", "dark", "#111213", "#f9fafd", "#b7b9bb"],
    ["mint", "light", "#fbfefe", "#121415", "#616464"],
    ["mint", "dark", "#101213", "#f7fbfc", "#b6b9ba"],
    ["lavender", "light", "#fdfdfe", "#131416", "#636365"],
    ["lavender", "dark", "#111113", "#f9fafd", "#b8b8bb"],
    ["blossom", "light", "#fdfdfe", "#131416", "#636365"],
    ["blossom", "dark", "#111113", "#f9fafd", "#b8b8bb"],
  ] as const)("uses an explicit Mermaid palette for %s %s", (theme, resolved, surface, foreground, line) => {
    const mermaidTheme = readMarkdownMermaidTheme(getBuiltinMermaidTheme(theme, resolved));

    expect(mermaidTheme.themeVariables).toMatchObject({
      primaryColor: surface,
      primaryTextColor: foreground,
      primaryBorderColor: line,
      lineColor: line,
    });
  });

  it("leaves unknown theme names to the computed-style resolver", () => {
    expect(getBuiltinMermaidTheme("constructor", "light")).toBeUndefined();
    expect(getBuiltinMermaidTheme("custom-backend-theme", "dark")).toBeUndefined();
  });
});
