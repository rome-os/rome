// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import Markdown from "@/components/markdown";
import { ThemeProvider } from "@/hooks/use-theme";
import en from "@/i18n/locales/en/chat.json";
import zh from "@/i18n/locales/zh-CN/chat.json";
import { CompactTextBlock } from "./blocks/TextBlock";
import ChatMarkdown from "./ChatMarkdown";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { chat: en }, "zh-CN": { chat: zh } } });

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

function Message({ text, chat = true }: { text: string; chat?: boolean }) {
  const MarkdownComponent = chat ? ChatMarkdown : Markdown;
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter>
          <MarkdownComponent>{text}</MarkdownComponent>
        </MemoryRouter>
      </ThemeProvider>
    </I18nextProvider>
  );
}

describe("ChatMarkdown hexadecimal color previews", () => {
  it("previews complete three- and six-digit inline-code colors", () => {
    const { container } = render(<Message text={"Colors: `#fdfcf9`, `#abc`, and `#A1b2C3`."} />);

    const previews = Array.from(
      container.querySelectorAll<HTMLElement>("[data-chat-color-preview]"),
    );
    expect(previews.map((preview) => preview.dataset.chatColorPreview)).toEqual([
      "#fdfcf9",
      "#abc",
      "#A1b2C3",
    ]);
    expect(previews.map((preview) => preview.style.backgroundColor)).toEqual([
      "rgb(253, 252, 249)",
      "rgb(170, 187, 204)",
      "rgb(161, 178, 195)",
    ]);
    expect(previews.every((preview) => preview.classList.contains("border-border-strong"))).toBe(
      true,
    );
  });

  it("does not preview prose, longer code, fenced code, or unsupported colors", () => {
    const { container } = render(
      <Message
        text={[
          "Bare #fdfcf9.",
          "`background: #fdfcf9` `#abcd` `#12345` `#12345678` `#ggg` `red` `rgb(1 2 3)`",
          "```css",
          "#abc",
          "```",
        ].join("\n\n")}
      />,
    );

    expect(container.querySelector("[data-chat-color-preview]")).toBeNull();
  });

  it("keeps the literal as the inline code's only accessible and copyable text", () => {
    const { container } = render(<Message text={"Color: `#fdfcf9`."} />);
    const code = container.querySelector('[data-streamdown="inline-code"]');
    const preview = code?.querySelector<HTMLElement>("[data-chat-color-preview]");

    expect(code?.textContent).toBe("#fdfcf9");
    expect(preview?.getAttribute("aria-hidden")).toBe("true");
    expect(preview?.hasAttribute("tabindex")).toBe(false);
    expect(preview?.hasAttribute("title")).toBe(false);
  });

  it("leaves hexadecimal inline code unchanged outside chat Markdown", () => {
    const { container } = render(<Message chat={false} text={"Color: `#fdfcf9`."} />);

    expect(container.querySelector("[data-chat-color-preview]")).toBeNull();
    expect(container.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe("#fdfcf9");
  });
});

describe("ChatMarkdown collapsible blocks", () => {
  it("re-measures compact text when an inner block collapses", () => {
    const OriginalResizeObserver = globalThis.ResizeObserver;
    const observers: TestResizeObserver[] = [];

    class TestResizeObserver implements ResizeObserver {
      readonly targets = new Set<Element>();

      constructor(private readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }

      observe(target: Element) {
        this.targets.add(target);
      }

      unobserve(target: Element) {
        this.targets.delete(target);
      }

      disconnect() {
        this.targets.clear();
      }

      resize(target: Element, width: number) {
        if (!this.targets.has(target)) return;
        this.callback([{ target, contentRect: { width } } as ResizeObserverEntry], this);
      }
    }

    globalThis.ResizeObserver = TestResizeObserver;
    try {
      const { container } = render(
        <I18nextProvider i18n={i18n}>
          <ThemeProvider>
            <MemoryRouter>
              <CompactTextBlock content={"```\nlong code\n```"} />
            </MemoryRouter>
          </ThemeProvider>
        </I18nextProvider>,
      );
      const compact = container.querySelector(".overflow-hidden") as HTMLDivElement;
      const markdown = compact.querySelector(".rome-markdown") as HTMLDivElement;
      Object.defineProperty(compact, "scrollHeight", {
        configurable: true,
        get: () => (compact.querySelector('[data-streamdown="code-block"]') ? 400 : 100),
      });

      act(() => observers.forEach((observer) => observer.resize(compact, 100)));
      expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Code" }));
      act(() => observers.forEach((observer) => observer.resize(markdown, 100)));
      expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    } finally {
      globalThis.ResizeObserver = OriginalResizeObserver;
    }
  });

  it("includes the visible language in the toggle's accessible name", () => {
    render(<Message text={"```js\nconst one = 1;\n```"} />);

    expect(screen.getByRole("button", { name: "js" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("expands code by default, collapses independently, and restores code and controls", () => {
    const { container } = render(
      <Message text={"```js\nconst one = 1;\n```\n\n```\nplain code\n```\n\n`inline`"} />,
    );
    const toggles = [
      screen.getByRole("button", { name: "js" }),
      screen.getByRole("button", { name: "Code" }),
    ];
    expect(container.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-streamdown="inline-code"]')).toHaveLength(1);
    const bodyId = toggles[0].getAttribute("aria-controls")!;
    expect(toggles[0].getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggles[0]);
    expect(document.getElementById(bodyId)?.hidden).toBe(true);
    expect(container.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(1);
    expect(toggles[1].getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggles[0]);
    expect(document.getElementById(bodyId)?.hidden).toBe(false);
    expect(container.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-streamdown="code-block-actions"]')).toHaveLength(2);
  });

  it("keeps a collapsed block closed during streaming and expands the latest content", () => {
    const { container, rerender } = render(<Message text={"```text\nfirst"} />);
    const toggle = screen.getByRole("button", { name: "text" });
    const bodyId = toggle.getAttribute("aria-controls");
    fireEvent.click(toggle);
    rerender(<Message text={"```text\nfirst\nsecond\n```\n\nDone."} />);
    expect(screen.getByRole("button", { name: "text" }).getAttribute("aria-controls")).toBe(bodyId);
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "text" }));
    expect(container.querySelector('[data-streamdown="code-block"]')?.textContent).toContain(
      "second",
    );
  });

  it("collapses Mermaid without routing it to the code highlighter", () => {
    const { container } = render(<Message text={"```mermaid\ngraph TD; A-->B;\n```"} />);
    const toggle = screen.getByRole("button", { name: "Mermaid diagram" });
    expect(toggle.textContent).toContain("Mermaid diagram");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Mermaid diagram" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull();
    expect(container.querySelector('[data-streamdown="inline-code"]')).toBeNull();
  });

  it("translates the toggle labels", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<Message text={"```\nplain code\n```"} />);
    const toggle = screen.getByRole("button", { name: "代码" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
