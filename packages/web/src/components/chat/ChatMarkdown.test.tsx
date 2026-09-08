// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@/hooks/use-theme";
import en from "@/i18n/locales/en/chat.json";
import zh from "@/i18n/locales/zh-CN/chat.json";
import ChatMarkdown from "./ChatMarkdown";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { chat: en }, "zh-CN": { chat: zh } } });

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

function Message({ text }: { text: string }) {
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter>
          <ChatMarkdown>{text}</ChatMarkdown>
        </MemoryRouter>
      </ThemeProvider>
    </I18nextProvider>
  );
}

describe("ChatMarkdown collapsible blocks", () => {
  it("expands code by default, collapses independently, and restores code and controls", () => {
    const { container } = render(
      <Message text={"```js\nconst one = 1;\n```\n\n```\nplain code\n```\n\n`inline`"} />,
    );
    const toggles = screen.getAllByRole("button", { name: "Collapse code block" });
    expect(toggles).toHaveLength(2);
    expect(container.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-streamdown="inline-code"]')).toHaveLength(1);
    const bodyId = toggles[0].getAttribute("aria-controls")!;
    expect(toggles[0].getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggles[0]);
    expect(document.getElementById(bodyId)?.hidden).toBe(true);
    expect(container.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(1);
    expect(toggles[1].getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Expand code block" }));
    expect(document.getElementById(bodyId)?.hidden).toBe(false);
    expect(container.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-streamdown="code-block-actions"]')).toHaveLength(2);
  });

  it("keeps a collapsed block closed during streaming and expands the latest content", () => {
    const { container, rerender } = render(<Message text={"```text\nfirst"} />);
    const toggle = screen.getByRole("button", { name: "Collapse code block" });
    const bodyId = toggle.getAttribute("aria-controls");
    fireEvent.click(toggle);
    rerender(<Message text={"```text\nfirst\nsecond\n```\n\nDone."} />);
    expect(
      screen.getByRole("button", { name: "Expand code block" }).getAttribute("aria-controls"),
    ).toBe(bodyId);
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand code block" }));
    expect(container.querySelector('[data-streamdown="code-block"]')?.textContent).toContain(
      "second",
    );
  });

  it("collapses Mermaid without routing it to the code highlighter", () => {
    const { container } = render(<Message text={"```mermaid\ngraph TD; A-->B;\n```"} />);
    const toggle = screen.getByRole("button", { name: "Collapse Mermaid diagram" });
    expect(toggle.textContent).toContain("Mermaid diagram");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Expand Mermaid diagram" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull();
    expect(container.querySelector('[data-streamdown="inline-code"]')).toBeNull();
  });

  it("translates the toggle labels", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<Message text={"```\nplain code\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: "收起代码块" }));
    expect(screen.getByRole("button", { name: "展开代码块" })).toBeTruthy();
  });
});
