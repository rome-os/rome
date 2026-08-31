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
  it.each([
    "queued",
    "submitted",
    "accepted",
  ] as const)("uses a visibly pending bubble for %s without a status line", (state) => {
    render(userMessage(state));

    const bubble = screen.getByTitle(`inputState.${state}`);
    expect(bubble.classList.contains("bg-transparent")).toBe(true);
    expect(bubble.classList.contains("border-dashed")).toBe(true);
    expect(bubble.classList.contains("border-border-strong")).toBe(true);
    expect(bubble.classList.contains("opacity-60")).toBe(false);
    expect(bubble.getAttribute("aria-busy")).toBe("true");
    expect(bubble.textContent).toBe(message.content);
    const status = screen.getByRole("status");
    expect(status.className).toBe("sr-only");
    expect(status.textContent).toBe(`inputState.${state}`);
  });

  it("restores the same bubble when the provider consumes the input", () => {
    const { rerender } = render(userMessage("queued"));
    const bubble = screen.getByTitle("inputState.queued");

    for (const state of ["submitted", "accepted"] as const) {
      rerender(userMessage(state));
      expect(screen.getByTitle(`inputState.${state}`)).toBe(bubble);
      expect(bubble.classList.contains("border-dashed")).toBe(true);
    }
    rerender(userMessage("consumed"));

    expect(bubble.isConnected).toBe(true);
    expect(bubble.classList.contains("bg-surface-muted")).toBe(true);
    expect(bubble.classList.contains("border-dashed")).toBe(false);
    expect(bubble.hasAttribute("title")).toBe(false);
    expect(bubble.hasAttribute("aria-busy")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it.each([
    ["failed", "border-destructive/50", "text-destructive"],
    ["unknown", "border-warning/50", "text-warning"],
    ["cancelled", "bg-transparent", "text-muted-foreground"],
  ] as const)("keeps %s distinct from pending delivery", (state, bubbleClass, iconClass) => {
    render(userMessage(state));

    const bubble = screen.getByTitle(`inputState.${state}`);
    expect(bubble.classList.contains(bubbleClass)).toBe(true);
    expect(bubble.classList.contains("bg-transparent")).toBe(state === "cancelled");
    expect(bubble.querySelector("svg")?.classList.contains(iconClass)).toBe(true);
    expect(bubble.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("status").className).toBe("sr-only");
  });

  it.each([
    undefined,
    null,
    "consumed",
  ] as const)("leaves a normal bubble for input state %s", (state) => {
    const { container } = render(userMessage(state));

    expect(screen.getByText(message.content)).toBeTruthy();
    expect(container.querySelector(".bg-surface-muted")).not.toBeNull();
    expect(container.querySelector(".border-dashed")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("copies only the message, not its delivery status", async () => {
    const writeText = rs.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(userMessage("submitted"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "message.copy" }));
    });

    expect(writeText).toHaveBeenCalledWith(message.content);
  });

  it("does not add a status-only bubble for a structured input without text", () => {
    const { container } = render(
      <UserMessage
        msg={{
          ...message,
          content: JSON.stringify([{ type: "interaction_result", toolUseId: "tool-1" }]),
          inputState: "queued",
        }}
      />,
    );

    expect(container.textContent).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
