// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@/hooks/use-theme";
import en from "@/i18n/locales/en/chat.json";
import type { ChatMessage } from "@/lib/chat-types";
import { UserMessageBubble } from "./UserMessageBubble";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { chat: en } } });

afterEach(() => cleanup());

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

function bubble(text: string) {
  const msg: ChatMessage = {
    id: "m1",
    sessionId: "s1",
    role: "user",
    content: JSON.stringify([{ type: "text", content: text }]),
    createdAt: "2026-11-12T00:00:00.000Z",
  };
  return render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter>
          <UserMessageBubble msg={msg} text={text} own />
        </MemoryRouter>
      </ThemeProvider>
    </I18nextProvider>,
  );
}

describe("a guardian message with uploads", () => {
  it("shows pictures as thumbnails and other files as chips, under the text", () => {
    const { container } = bubble(
      [
        "Two pictures and a file",
        "",
        `- File 1: [image.png](</api/assets/${ID}.png>)`,
        `- File 2: [image.png](</api/assets/${OTHER}.png>)`,
        `- File 3: [budget.xlsx](</api/assets/${ID}.xlsx>)`,
        `- File 4: [spec.pdf](</api/assets/${OTHER}.pdf>)`,
      ].join("\n"),
    );

    expect(screen.getByText("Two pictures and a file")).toBeTruthy();
    const images = screen.getAllByRole("img", { name: "image.png" });
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      `/api/assets/${ID}.png?w=900`,
      `/api/assets/${OTHER}.png?w=900`,
    ]);
    const chip = screen.getByText("budget.xlsx").closest("a") as HTMLAnchorElement;
    expect(chip.getAttribute("href")).toBe(`/api/assets/${ID}.xlsx`);
    expect(chip.getAttribute("download")).toBe("budget.xlsx");
    expect(screen.getByText("spec.pdf").closest("a")?.getAttribute("download")).toBe("spec.pdf");
    // The upload lines are not left behind as text.
    expect(container.textContent).not.toContain("File 1");
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  it("renders a message of only files without an empty text block", () => {
    const { container } = bubble(`- File 1: [image.png](</api/assets/${ID}.png>)`);
    expect(screen.getByRole("img", { name: "image.png" })).toBeTruthy();
    expect(container.querySelector("p")).toBeNull();
  });

  it("keeps older /projects upload lines as the links they were", () => {
    bubble("Look\n\n- File 1: [image.png](</projects/default/2026/11/11/image.png>)");
    const link = screen.getByText("image.png").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/projects/default/2026/11/11/image.png");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not split a list line that sits in the middle of the text", () => {
    const text = `- File 1: [image.png](</api/assets/${ID}.png>)\n\nand more words after it`;
    bubble(text);
    expect(screen.queryByRole("img", { name: "image.png" })).toBeNull();
    expect(screen.getByText("and more words after it")).toBeTruthy();
  });
});
