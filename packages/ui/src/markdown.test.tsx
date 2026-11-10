import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { Markdown, type MarkdownTheme, readMarkdownMermaidTheme } from "./markdown.js";

beforeEach(() => {
  rs.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  document.documentElement.className = "";
});

function renderMd(md: string, props: { compact?: boolean; className?: string } = {}) {
  return render(<Markdown {...props}>{md}</Markdown>);
}

describe("Markdown", () => {
  it("does not observe ordinary Markdown while its content streams", () => {
    const observe = rs.spyOn(MutationObserver.prototype, "observe");
    const { container, rerender } = renderMd("Hello");
    const root = container.firstElementChild;

    for (const content of [
      "Hello, world.",
      "Hello, world.\n\nThe mermaid diagram comes later.",
      "Hello, world.\n\n```typescript\nconst diagram = 'mermaid';\n```",
    ]) {
      rerender(<Markdown>{content}</Markdown>);
      expect(observe.mock.calls.filter(([target]) => target === root)).toHaveLength(0);
      expect(container.children).toHaveLength(1);
    }
  });

  it.each([
    "```mermaid",
    "~~~mermaid",
    "````mermaid",
    "  ``` mermaid",
    "> ```mermaid",
    "- ```mermaid",
  ])("observes a Mermaid opening fence without waiting for its closing fence: %s", (fence) => {
    const observe = rs.spyOn(MutationObserver.prototype, "observe");
    const { container } = renderMd(`${fence}\ngraph TD; A-->B;`);

    expect(observe.mock.calls).toContainEqual([
      container.firstElementChild,
      { childList: true, subtree: true },
    ]);
  });

  it("starts observing when a streamed fence arrives and stops when Mermaid content is removed", async () => {
    const { container, rerender } = renderMd("A reply\n\n```mer");
    const root = container.querySelector(".rome-markdown")!;
    const scan = rs.spyOn(root, "querySelectorAll");

    rerender(<Markdown>{"A reply\n\n```mermaid\ngraph TD; A-->B;"}</Markdown>);
    expect(scan).toHaveBeenCalledWith('[data-streamdown="mermaid-block-actions"]');

    rerender(<Markdown>A plain reply</Markdown>);
    scan.mockClear();
    await act(async () => {
      root.append(document.createElement("p"));
    });

    expect(scan).not.toHaveBeenCalledWith('[data-streamdown="mermaid-block-actions"]');
    expect(container.children).toHaveLength(1);
  });

  it("passes a host URL transform through without changing the image renderer", () => {
    render(
      <Markdown urlTransform={(url, key) => (key === "src" ? `/assets${url}` : url)}>
        {"![Preview](/preview.png)\n\n[Open file](/preview.png)"}
      </Markdown>,
    );

    expect(screen.getByRole("img", { name: "Preview" }).getAttribute("src")).toBe(
      "/assets/preview.png",
    );
    expect(screen.getByRole("link", { name: "Open file" }).getAttribute("href")).toBe(
      "/preview.png",
    );
  });

  it("loads images lazily and decodes them off the main thread", () => {
    render(<Markdown>{"![Preview](/preview.png)"}</Markdown>);

    const image = screen.getByRole("img", { name: "Preview" });
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("decoding")).toBe("async");
  });

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

  it("lets prose links lead by color alone, underlined on hover and focus, without added weight", () => {
    renderMd("Read the [guide](./guide.md).");

    const classes = screen.getByRole("link", { name: "guide" }).className.split(/\s+/);
    expect(classes).toContain("text-primary");
    expect(classes).toContain("no-underline");
    expect(classes).toContain("hover:underline");
    expect(classes).toContain("focus-visible:underline");
    expect(classes).not.toContain("font-medium");
  });

  it("leaves no blank text beside a nested list, which soft-break prose would draw as an empty line", () => {
    const { container } = render(
      <Markdown preserveSoftBreaks>
        {"1. **First**\n   - a\n   - b\n2. **Second**\n   - c"}
      </Markdown>,
    );

    const items = container.querySelectorAll("ol > li");
    expect(items).toHaveLength(2);
    for (const item of items) {
      const blank = [...item.childNodes].filter(
        (node) => node.nodeType === Node.TEXT_NODE && !node.textContent?.trim(),
      );
      expect(blank).toHaveLength(0);
    }
    // A soft break inside an item's own text is kept.
    cleanup();
    const soft = render(<Markdown preserveSoftBreaks>{"- one\n  two"}</Markdown>);
    expect(soft.container.querySelector("li")?.textContent).toBe("one\ntwo");
  });

  it("shortens a link whose text is a long hash, and keeps the whole hash in its tooltip", () => {
    const sha = "d37eb0f1c4a9e2b7f3d1a6c8e0b5f9a2d4c7e1b3";
    renderMd(`Merged as [${sha}](https://example.com/commit/${sha}).`);

    const link = screen.getByRole("link", { name: "d37eb0f" });
    expect(link.getAttribute("title")).toBe(sha);
    expect(link.getAttribute("href")).toBe(`https://example.com/commit/${sha}`);
  });

  it("leaves link text that is not a hash as it is", () => {
    renderMd(
      "[deadbeefcafe0](https://a.example) [1234567890123](https://b.example) [abc123](https://c.example)",
    );

    // Hex with a digit and 12 characters or more is a hash; all digits, or short, is not.
    expect(screen.getByRole("link", { name: "deadbee" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "1234567890123" }).getAttribute("title")).toBeNull();
    expect(screen.getByRole("link", { name: "abc123" }).getAttribute("title")).toBeNull();
  });

  it("routes ```mermaid fences to the mermaid plugin, not the shiki code highlighter", () => {
    const { container } = renderMd("```mermaid\ngraph TD; A-->B;\n```");
    // The mermaid plugin renders asynchronously (Pele, loaded on demand),
    // so synchronously we only see its loading skeleton. The meaningful guard
    // is that the fence is NOT handed to the shiki code block — and isn't
    // rendered as a plain paragraph of source text either.
    expect(container.querySelector("[data-streamdown='code-block']")).toBeNull();
    expect(container.querySelector("[data-streamdown='inline-code']")).toBeNull();
    expect(container.textContent ?? "").not.toContain("graph TD");
  });

  it("renders a ```mermaid fence to a Pele SVG once the block scrolls into view", async () => {
    rs.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    rs.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          this.callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );
    const { container } = renderMd("```mermaid\ngraph TD; A-->B;\n```");

    await waitFor(() => expect(container.querySelector("svg.pele-flowchart")).not.toBeNull());
    const style = container.querySelector("svg.pele-flowchart")?.getAttribute("style") ?? "";
    expect(style).toContain("--pele-line:");
  });

  it("renders inline and block math with KaTeX once the math plugin loads", async () => {
    const { container } = renderMd(
      "Euler's identity is $$e^{i\\pi} + 1 = 0$$.\n\n$$\nE = mc^2\n$$",
    );

    await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(2));
    expect(container.querySelectorAll(".katex-mathml")).toHaveLength(2);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
  });

  it("does not interpret single dollar signs as math", async () => {
    // The $$ loads the math plugin, so the single dollars are parsed with it.
    const { container } = renderMd(
      "The first item costs $5 and the second costs $10, unlike $$x$$.",
    );

    await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(1));
    expect(container.textContent).toContain("$5");
    expect(container.textContent).toContain("$10");
  });

  it("drops an empty item that ends a list, which would render a bare bullet", () => {
    for (const md of ["- a\n- b\n-\n", "* a\n* b\n* ", "1. a\n2. b\n3. "]) {
      const { container, unmount } = renderMd(md);
      const items = [...container.querySelectorAll("li")].map((li) => li.textContent);
      expect(items).toEqual(["a", "b"]);
      unmount();
    }
  });

  it("drops a nested list's trailing empty item, and a list left with none", () => {
    const { container } = renderMd("- a\n  - b\n  -\n\ntext\n\n-\n");
    // One outer list holding one nested list; the bare `-` after the text
    // leaves no list of its own.
    expect(container.querySelectorAll("ul")).toHaveLength(2);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("li li")?.textContent).toBe("b");
  });

  it("shows a message that is only an empty list item as its text", () => {
    for (const md of ["408.", "391.", "1.", "-", "* "]) {
      const { container, unmount } = renderMd(md);
      expect(container.querySelector("li")).toBeNull();
      expect(container.textContent?.trim()).toBe(md.trim());
      unmount();
    }
  });

  it("shows a list of only empty items as its text, and keeps the text around it", () => {
    const { container } = renderMd("Done.\n\n1.\n2.");

    expect(container.querySelector("ol")).toBeNull();
    expect(container.textContent).toContain("Done.");
    expect(container.textContent).toContain("1.\n2.");
  });

  it("keeps an empty item inside a list", () => {
    const { container } = renderMd("- a\n-\n- b");

    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("lets a table grow to its full height instead of scrolling inside a cap", () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| row ${i} | value ${i} |`).join("\n");
    const { container } = renderMd(`| Key | Value |\n| --- | --- |\n${rows}`);
    const scroller = container.querySelector('[data-streamdown="table"]')?.parentElement;

    expect(scroller).not.toBeNull();
    expect(scroller?.style.maxHeight).toBe("");
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
  // The theme is only resolved for content with a Mermaid fence.
  const mermaid = (label: string) => `\`\`\`mermaid\ngraph TD; A-->B; %% ${label}\n\`\`\``;

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

  it("does not resolve the theme for Markdown without a Mermaid fence", () => {
    const reads = countThemeReads(
      <>
        <Markdown>plain text</Markdown>
        <Markdown>{"```typescript\nconst diagram = 'mermaid';\n```"}</Markdown>
      </>,
    );

    expect(reads).toBe(0);
  });

  it("resolves the theme when streamed content gains a Mermaid fence", () => {
    const single = readsPerResolve();
    const { rerender } = render(<Markdown>plain text</Markdown>);
    const spy = rs.spyOn(window, "getComputedStyle");
    expect(spy.mock.calls.length).toBe(0);

    rerender(<Markdown>{mermaid("streamed")}</Markdown>);

    // Resolved at least once. Creating the root observer on this first commit
    // marks the just-resolved entry stale (see subscribeToThemeRoot), so the
    // follow-up render may re-validate it once more: at most twice, ever.
    const flipReads = spy.mock.calls.length;
    expect(flipReads).toBeGreaterThanOrEqual(single);
    expect(flipReads).toBeLessThanOrEqual(2 * single);

    // Once the observer watches the root, further content does not re-resolve.
    rerender(<Markdown>{mermaid("streamed, longer")}</Markdown>);
    expect(spy.mock.calls.length).toBe(flipReads);
  });

  it("resolves the theme once however many instances are mounted", () => {
    const single = countThemeReads(<Markdown>{mermaid("one")}</Markdown>);
    const many = countThemeReads(
      <>
        {Array.from({ length: 20 }, (_, index) => (
          <Markdown key={index}>{mermaid(`message ${index}`)}</Markdown>
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
          <Markdown key={index}>{mermaid(`message ${index}`)}</Markdown>
        ))}
      </>,
    );
    const spy = rs.spyOn(window, "getComputedStyle");

    await act(async () => {
      document.documentElement.classList.add("dark");
    });

    expect(spy.mock.calls.length).toBe(single);
  });

  it("keeps the resolved theme when only the root's inline style changes", async () => {
    render(
      <>
        {Array.from({ length: 5 }, (_, index) => (
          <Markdown key={index}>{mermaid(`message ${index}`)}</Markdown>
        ))}
      </>,
    );
    const spy = rs.spyOn(window, "getComputedStyle");

    await act(async () => {
      document.documentElement.style.setProperty("--rome-viewport-height", "512px");
    });
    document.documentElement.style.removeProperty("--rome-viewport-height");

    expect(spy.mock.calls.length).toBe(0);
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
        <Markdown>{mermaid("discarded")}</Markdown>
        <Suspends />
      </Suspense>,
    );
    cleanup();
    document.documentElement.classList.add("dark");
    const spy = rs.spyOn(window, "getComputedStyle");

    render(<Markdown>{mermaid("mounted")}</Markdown>);

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
