// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider } from "@/hooks/use-theme";
import type { ChatMessage } from "@/lib/chat-types";
import { UserMessage } from "./UserMessage";

rs.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => cleanup());

const message: ChatMessage = {
  id: "input-1",
  sessionId: "session-1",
  role: "user",
  content: "Also include pseudocode.",
  createdAt: "2026-08-28T00:00:00.000Z",
};

function userMessage(inputState?: ChatMessage["inputState"]) {
  return (
    <ThemeProvider>
      <UserMessage msg={{ ...message, inputState }} />
    </ThemeProvider>
  );
}

describe("UserMessage input state", () => {
  it.each(["sent", "read"] as const)("uses a visibly pending bubble for %s", (state) => {
    render(userMessage(state));
    const bubble = screen.getByTitle(`inputState.${state}`);
    expect(bubble.classList.contains("bg-transparent")).toBe(true);
    expect(bubble.classList.contains("border-dashed")).toBe(true);
    expect(bubble.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe(`inputState.${state}`);
  });

  it("restores a normal bubble once the model turn answers", () => {
    const { rerender } = render(userMessage("sent"));
    const bubble = screen.getByTitle("inputState.sent");
    rerender(userMessage("read"));
    expect(screen.getByTitle("inputState.read")).toBe(bubble);
    rerender(userMessage("answered"));
    expect(bubble.classList.contains("bg-surface-muted")).toBe(true);
    expect(bubble.classList.contains("border-dashed")).toBe(false);
    expect(bubble.hasAttribute("title")).toBe(false);
    expect(bubble.hasAttribute("aria-busy")).toBe(false);
  });

  it("copies only the message, not its delivery status", async () => {
    const writeText = rs.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(userMessage("read"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "message.copy" })));
    expect(writeText).toHaveBeenCalledWith(message.content);
  });

  it("does not add a status-only bubble for a structured input without text", () => {
    const { container } = render(
      <UserMessage
        msg={{
          ...message,
          content: JSON.stringify([{ type: "interaction_result", toolUseId: "tool-1" }]),
          inputState: "sent",
        }}
      />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
