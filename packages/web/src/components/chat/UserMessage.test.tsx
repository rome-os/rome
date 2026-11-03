// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider } from "@/hooks/use-theme";
import type { ChatMessage } from "@/lib/chat-types";
import { UserMessage } from "./UserMessage";
import { ReplyDraftProvider, type ReplyDraft } from "./reply/reply-draft";

const viewer = rs.hoisted(() => ({
  current: { kind: "guardian", userId: "seat", displayName: "Ray", avatarUrl: null } as
    | { kind: "guardian"; userId: string; displayName: string | null; avatarUrl: string | null }
    | { kind: "visitor"; accountId: string; email: string; avatarUrl: string | null },
}));

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({ data: viewer.current }),
}));

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
  ] as const)("breathes a normal bubble for %s without a status line", (state) => {
    render(userMessage(state));

    const bubble = screen.getByTitle(`inputState.${state}`);
    expect(bubble.getAttribute("aria-busy")).toBe("true");
    expect(bubble.textContent).toBe(message.content);
    expect(screen.getByRole("status").textContent).toBe(`inputState.${state}`);
  });

  it("restores the same bubble when the provider consumes the input", () => {
    const { rerender } = render(userMessage("queued"));
    const bubble = screen.getByTitle("inputState.queued");

    for (const state of ["submitted", "accepted"] as const) {
      rerender(userMessage(state));
      expect(screen.getByTitle(`inputState.${state}`)).toBe(bubble);
      expect(bubble.getAttribute("aria-busy")).toBe("true");
    }
    rerender(userMessage("consumed"));

    expect(bubble.isConnected).toBe(true);
    expect(bubble.hasAttribute("title")).toBe(false);
    expect(bubble.hasAttribute("aria-busy")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it.each([
    "failed",
    "unknown",
    "cancelled",
  ] as const)("keeps %s distinct from pending delivery", (state) => {
    render(userMessage(state));

    const bubble = screen.getByTitle(`inputState.${state}`);
    expect(bubble.hasAttribute("aria-busy")).toBe(false);
    expect(bubble.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe(`inputState.${state}`);
  });

  it.each([
    undefined,
    null,
    "consumed",
  ] as const)("leaves a normal bubble for input state %s", (state) => {
    const { container } = render(userMessage(state));

    expect(screen.getByText(message.content)).toBeTruthy();
    expect(container.querySelector(".bg-primary")).not.toBeNull();
    expect(container.querySelector(".border-dashed")).toBeNull();
    expect(container.querySelector(".rome-bubble-pending")).toBeNull();
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

describe("UserMessage sender", () => {
  const ada = {
    kind: "visitor",
    accountId: "acct-ada",
    name: "ada@example.com",
    avatarUrl: null,
  } as const;
  const withSender = (sender: ChatMessage["sender"]) => (
    <ThemeProvider>
      <UserMessage msg={{ ...message, sender }} />
    </ThemeProvider>
  );
  const side = (container: HTMLElement) =>
    container.querySelector('[data-slot="avatar"]')?.closest(".justify-end") ? "right" : "left";

  afterEach(() => {
    viewer.current = { kind: "guardian", userId: "seat", displayName: "Ray", avatarUrl: null };
  });

  it("puts the signed-in person's own message on the right with their avatar", () => {
    const { container } = render(withSender({ kind: "guardian", name: "Ray", avatarUrl: null }));

    expect(screen.getByTitle("Ray").textContent).toBe("R");
    expect(side(container)).toBe("right");
  });

  it("puts someone else's message on the left under their name", () => {
    const { container } = render(withSender(ada));

    expect(screen.getByTitle("ada@example.com").textContent).toBe("A");
    expect(screen.getByText("ada@example.com", { selector: "span" })).toBeTruthy();
    expect(side(container)).toBe("left");
  });

  it("tells a visitor's own message from another visitor's by account", () => {
    viewer.current = {
      kind: "visitor",
      accountId: "acct-ada",
      email: "ada@example.com",
      avatarUrl: null,
    };
    const own = render(withSender(ada));
    expect(side(own.container)).toBe("right");
    own.unmount();

    const guardian = render(withSender({ kind: "guardian", name: "Ray", avatarUrl: null }));
    expect(side(guardian.container)).toBe("left");
  });

  it("keeps a message that recorded no sender on the right, with no avatar", () => {
    const { container } = render(withSender(undefined));

    expect(container.querySelector('[data-slot="avatar"]')).toBeNull();
    expect(container.querySelector(".justify-end")).not.toBeNull();
  });

  it("follows a sender whose name changes on a later load", () => {
    const { rerender } = render(withSender({ kind: "guardian", name: null, avatarUrl: null }));
    rerender(withSender({ kind: "guardian", name: "Ray", avatarUrl: null }));

    expect(screen.getByTitle("Ray").textContent).toBe("R");
  });
});

describe("UserMessage reply", () => {
  const draft = (overrides: Partial<ReplyDraft> = {}): ReplyDraft => ({
    sessionId: "session-1",
    target: null,
    set: rs.fn(),
    clear: rs.fn(),
    restore: rs.fn(),
    has: () => true,
    jump: rs.fn(),
    ...overrides,
  });
  const inChat = (
    reply: ReplyDraft,
    inputState?: ChatMessage["inputState"],
    content = message.content,
  ) => (
    <ReplyDraftProvider value={reply}>
      <ThemeProvider>
        <UserMessage msg={{ ...message, content, inputState }} />
      </ThemeProvider>
    </ReplyDraftProvider>
  );

  it("replies to a message the agent has taken in", () => {
    const reply = draft();
    render(inChat(reply, "consumed"));

    fireEvent.click(screen.getByRole("button", { name: "reply.action" }));

    expect(reply.set).toHaveBeenCalledWith({
      messageId: "input-1",
      author: "guardian",
      preview: "Also include pseudocode.",
    });
  });

  it.each([
    "queued",
    "submitted",
    "failed",
  ] as const)("offers no Reply on a message that is %s", (state) => {
    render(inChat(draft(), state));

    expect(screen.queryByRole("button", { name: "reply.action" })).toBeNull();
  });

  it("shows the quote a reply carries, linked to the original", () => {
    const reply = draft();
    const content = JSON.stringify([
      { type: "reply_to", messageId: "a-9", author: "agent", text: "Use a heap." },
      { type: "text", content: "Also include pseudocode." },
    ]);
    render(inChat(reply, "consumed", content));

    fireEvent.click(screen.getByRole("button", { name: "reply.jump" }));

    expect(reply.jump).toHaveBeenCalledWith("a-9");
    expect(screen.getByText("Use a heap.")).toBeTruthy();
    expect(screen.getByText("Also include pseudocode.")).toBeTruthy();
  });
});
