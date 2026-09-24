import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { Markdown, type MarkdownTheme, readMarkdownMermaidTheme } from "./markdown.js";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  document.documentElement.className = "";
});

function renderMd(md: string, props: { compact?: boolean; className?: string } = {}) {
  return render(<Markdown {...props}>{md}</Markdown>);
}

describe("Markdown", () => {
  it("tags the root with rome-markdown, the hook hosts style prose through", () => {
    const { container } = renderMd("hello");
    const root = container.querySelector(".rome-markdown");
    expect(root).not.toBeNull();
    expect(root?.classList).not.toContain("rome-markdown-compact");
    expect(root?.className).not.toMatch(/text-(?:body|aux|prose)/);
  });

  it("renders headings, emphasis and inline code", () => {
    const { container } = renderMd("# Title\n\nHello **world** and `inline()` code.");
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeTruthy();
    expect(screen.getByText("world")).toBeTruthy();
    expect(container.querySelector("code")?.textContent).toContain("inline()");
  });

  it("renders every heading level without Streamdown typography utilities", () => {
    const { container } = renderMd(
      "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six",
    );

    for (const heading of screen.getAllByRole("heading")) {
      expect(heading.classList).not.toContain("font-semibold");
      expect(heading.getAttribute("data-streamdown")).toBe(`heading-${heading.tagName.slice(1)}`);
    }
    expect(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(6);
  });

  it("preserves semantic heading hooks when a heading is nested in a quotation", () => {
    const { container } = renderMd("> ## Quoted heading");
    const heading = screen.getByRole("heading", { level: 2, name: "Quoted heading" });

    expect(heading.getAttribute("data-streamdown")).toBe("heading-2");
    expect(heading.closest('[data-streamdown="blockquote"]')).toBe(
      container.querySelector('[data-streamdown="blockquote"]'),
    );
  });

  it("only opens genuinely external links in a new tab", () => {
    const sameOrigin = `${window.location.origin}/path`;
    renderMd(
      `[relative](./guide.md) [parent](../LICENSE) [mail](mailto:team@example.com) [phone](tel:+15555550123) [same](${sameOrigin}) [external](https://example.com)`,
    );

    for (const name of ["relative", "parent", "mail", "phone", "same"]) {
      const link = screen.getByRole("link", { name }) as HTMLAnchorElement;
      expect(link.target).toBe("");
      expect(link.rel).toBe("");
    }

    const external = screen.getByRole("link", { name: "external" }) as HTMLAnchorElement;
    expect(external.target).toBe("_blank");
    expect(external.rel).toContain("noopener");
  });

  it("lets prose links lead by color and underline without added weight", () => {
    renderMd("Read the [guide](./guide.md).");

    const classes = screen.getByRole("link", { name: "guide" }).className.split(/\s+/);
    expect(classes).toContain("text-primary");
    expect(classes).toContain("underline");
    expect(classes).not.toContain("font-medium");
  });

  it("routes ```mermaid fences to the mermaid plugin, not the shiki code highlighter", () => {
    const { container } = renderMd("```mermaid\ngraph TD; A-->B;\n```");
    // The mermaid plugin renders asynchronously (mermaid.js, behind Suspense),
    // so synchronously we only see its loading skeleton. The meaningful guard
    // is that the fence is NOT handed to the shiki code block — and isn't
    // rendered as a plain paragraph of source text either.
    expect(container.querySelector("[data-streamdown='code-block']")).toBeNull();
    expect(container.querySelector("[data-streamdown='inline-code']")).toBeNull();
    expect(container.textContent ?? "").not.toContain("graph TD");
  });

  it("renders inline and block math with KaTeX", () => {
    const { container } = renderMd(
      "Euler's identity is $$e^{i\\pi} + 1 = 0$$.\n\n$$\nE = mc^2\n$$",
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelectorAll(".katex-mathml")).toHaveLength(2);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
  });

  it("does not interpret single dollar signs as math", () => {
    const { container } = renderMd("The first item costs $5 and the second costs $10.");

    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5");
    expect(container.textContent).toContain("$10");
  });

  it("marks compact mode without changing semantic element roles", () => {
    const { container } = renderMd("# Title\n\nBody", {
      compact: true,
      className: "text-foreground",
    });
    const root = container.querySelector(".rome-markdown");

    expect(root?.classList).toContain("rome-markdown-compact");
    expect(root?.classList).toContain("text-foreground");
    expect(screen.getByRole("heading", { level: 1 }).getAttribute("data-streamdown")).toBe(
      "heading-1",
    );
  });
});

describe("Markdown Mermaid theme", () => {
  function countThemeReads(ui: React.ReactElement): number {
    const spy = rs.spyOn(window, "getComputedStyle");
    render(ui);
    const reads = spy.mock.calls.length;
    cleanup();
    spy.mockRestore();
    return reads;
  }

  function readsPerResolve(): number {
    const spy = rs.spyOn(window, "getComputedStyle");
    readMarkdownMermaidTheme();
    const reads = spy.mock.calls.length;
    spy.mockRestore();
    return reads;
  }

  it("resolves the theme once however many instances are mounted", () => {
    const single = countThemeReads(<Markdown>one</Markdown>);
    const many = countThemeReads(
      <>
        {Array.from({ length: 20 }, (_, index) => (
          <Markdown key={index}>{`message ${index}`}</Markdown>
        ))}
      </>,
    );

    expect(single).toBeGreaterThan(0);
    expect(many).toBe(single);
  });

  it("resolves the theme again once when the theme root changes", async () => {
    const single = readsPerResolve();
    render(
      <>
        {Array.from({ length: 5 }, (_, index) => (
          <Markdown key={index}>{`message ${index}`}</Markdown>
        ))}
      </>,
    );
    const spy = rs.spyOn(window, "getComputedStyle");

    await act(async () => {
      document.documentElement.classList.add("dark");
    });

    expect(spy.mock.calls.length).toBe(single);
  });

  it("re-validates a theme resolved by a render that never committed", async () => {
    const single = readsPerResolve();
    // The sibling suspends, so React discards the Markdown render after it
    // resolved the theme, and no instance ever watches the root.
    const never = new Promise<never>(() => {});
    function Suspends(): never {
      throw never;
    }
    render(
      <Suspense fallback={null}>
        <Markdown>discarded</Markdown>
        <Suspends />
      </Suspense>,
    );
    cleanup();
    document.documentElement.classList.add("dark");
    const spy = rs.spyOn(window, "getComputedStyle");

    render(<Markdown>mounted</Markdown>);

    expect(spy.mock.calls.length).toBe(single);
  });

  it("does not re-render new instances when they replace the old ones in one commit", () => {
    // Every Markdown render reads `theme.mermaid`, so the getter counts renders.
    let renders = 0;
    const theme: MarkdownTheme = {
      get mermaid() {
        renders++;
        return undefined;
      },
    };
    const transcript = (id: string) =>
      Array.from({ length: 3 }, (_, index) => (
        <Markdown key={`${id}-${index}`} theme={theme}>{`${id} message ${index}`}</Markdown>
      ));
    const { rerender } = render(<>{transcript("a")}</>);
    const mountRenders = renders;
    renders = 0;

    rerender(<>{transcript("b")}</>);

    expect(renders).toBe(mountRenders);
  });
});
