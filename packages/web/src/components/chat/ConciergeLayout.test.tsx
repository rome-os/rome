// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatMessage } from "@/lib/chat-types";
import "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import { ConciergeTranscript } from "./ConciergeTranscript";
import type { ChatRow } from "./chat-view";
import type { BlockActions, LivePreview } from "./MessageList";
import { ReplyDraftProvider, type ReplyDraft } from "./reply/reply-draft";

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: "Ray", avatarUrl: null },
  }),
}));
// The card reads the chat list; the transcript only decides what surrounds it.
rs.mock("@/components/chat/entries/TaskChatCard", () => ({
  TaskChatCard: ({ title }: { title: string }) => <div data-testid="task-card">{title}</div>,
}));
// The real buttons fetch and observe the viewport; the transcript only decides
// where they appear and for which turn.
rs.mock("@/components/chat/TurnFeedbackButtons", () => ({
  TurnFeedbackButtons: ({ turnId }: { turnId: string }) => (
    <button type="button" data-testid="feedback" data-turn={turnId}>
      feedback
    </button>
  ),
}));

beforeEach(() => {
  rs.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

function stubHover(hover: boolean) {
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: query === "(hover: none)" ? !hover : false,
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
}

const T0 = new Date(2026, 9, 27, 12, 0, 0).getTime();
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function agent(id: string, offsetMs: number, parts: unknown[], turnId = "turn-1"): ChatMessage {
  return {
    id,
    sessionId: "concierge",
    turnId,
    role: "assistant",
    content: JSON.stringify(parts),
    createdAt: at(offsetMs),
  } as ChatMessage;
}

function guardian(id: string, offsetMs: number, text: string, extra: Partial<ChatMessage> = {}) {
  return {
    id,
    sessionId: "concierge",
    role: "user",
    content: JSON.stringify([{ type: "text", content: text }]),
    createdAt: at(offsetMs),
    ...extra,
  } as ChatMessage;
}

const userRow = (message: ChatMessage): ChatRow => ({ kind: "user", key: message.id, message });
const agentRow = (...messages: ChatMessage[]): ChatRow =>
  ({
    kind: "agent",
    key: messages[0].id,
    identity: { name: "Rome", iconUrl: null },
    trace: null,
    messages,
  }) as ChatRow;

const text = (content: string, format?: "long") => ({
  type: "text",
  content,
  ...(format ? { format } : {}),
});

const actions = {
  onApprovalResolved: () => {},
  onSubmitAppComponent: () => {},
  onDismissAppComponent: () => {},
  interactionResults: new Map(),
} as BlockActions;

const idle = {
  isStreaming: false,
  runningTurnId: null,
  snapshot: null,
  text: "",
  identity: { name: "Rome", iconUrl: null },
} as LivePreview;

function renderTranscript(rows: ChatRow[], opts: { live?: LivePreview } = {}) {
  return render(
    <ThemeProvider>
      <ConciergeTranscript
        rows={rows}
        live={opts.live ?? idle}
        actions={actions}
        contentRef={() => {}}
        feedback
      />
    </ThemeProvider>,
  );
}

/** The bubble element that holds `content`, however deep the markdown nests it. */
function bubbleOf(content: string): HTMLElement {
  const bubble = screen.getByText(content).closest<HTMLElement>("div.rounded-16");
  if (!bubble) throw new Error(`no bubble around ${content}`);
  return bubble;
}

describe("Concierge layout", () => {
  describe("with a pointer that can hover", () => {
    beforeEach(() => stubHover(true));

    it("draws no action row under a settled turn", () => {
      renderTranscript([agentRow(agent("a1", 0, [text("Found three.")]))]);

      expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
      expect(screen.queryByTestId("feedback")).toBeNull();
      expect(screen.getByRole("button", { name: "Message details" })).toBeTruthy();
    });

    // jsdom has no layout, so these pin the wiring that decides where the popover
    // opens; the measured placement is checked in a real browser.
    it("anchors the popover to the more button, not to the bubble", () => {
      renderTranscript([agentRow(agent("a1", 0, [text("Found three.")]))]);
      const more = screen.getByRole("button", { name: "Message details" });

      fireEvent.click(more);

      expect(document.querySelector("[data-slot=popover-anchor]")).toBeNull();
      expect(more.getAttribute("aria-controls")).toBe(
        document.querySelector("[data-slot=popover-content]")?.id,
      );
    });

    // jsdom has no layout, so the column and the button get fixed rects: a 1000px
    // column, and the button's left edge at `buttonLeft`.
    function stubRects(buttonLeft: number) {
      const rect = (left: number, right: number) =>
        ({ left, right, top: 0, bottom: 28, width: right - left, height: 28 }) as DOMRect;
      rs.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.matches("[data-chat-transcript]")) return rect(0, 1000);
        if (this.getAttribute("aria-label") === "Message details") {
          return rect(buttonLeft, buttonLeft + 28);
        }
        return rect(0, 0);
      });
    }
    const popover = () => document.querySelector("[data-slot=popover-content]");

    it("opens the agent's popover to the right of the button", () => {
      stubRects(100);
      renderTranscript([agentRow(agent("a1", 0, [text("Found three.")]))]);

      fireEvent.click(screen.getByRole("button", { name: "Message details" }));

      expect(popover()?.getAttribute("data-side")).toBe("right");
      expect(popover()?.getAttribute("data-align")).toBe("center");
    });

    it("opens the guardian's popover to the left of the button", () => {
      stubRects(800);
      renderTranscript([userRow(guardian("u1", 0, "Find me a cafe"))]);

      fireEvent.click(screen.getByRole("button", { name: "Message details" }));

      expect(popover()?.getAttribute("data-side")).toBe("left");
      expect(popover()?.getAttribute("data-align")).toBe("center");
    });

    it("opens below the button, toward the bubble, when the empty side is too narrow", () => {
      // The agent's button is 100px from the column's right edge.
      stubRects(872);
      renderTranscript([agentRow(agent("a1", 0, [text("A long reply that fills the column.")]))]);

      fireEvent.click(screen.getByRole("button", { name: "Message details" }));

      expect(popover()?.getAttribute("data-side")).toBe("bottom");
      expect(popover()?.getAttribute("data-align")).toBe("end");
    });

    it("keeps the more button out of the layout", () => {
      renderTranscript([agentRow(agent("a1", 0, [text("Found three.")]))]);

      const more = screen.getByRole("button", { name: "Message details" });
      expect(more.closest(".absolute")).toBeTruthy();
      expect(more.className).toContain("opacity-0");
      expect(more.className).toContain("group-hover/bubble:opacity-100");
      expect(more.className).toContain("aria-expanded:opacity-100");
    });

    it("opens the time, copy, and feedback from the more button", () => {
      renderTranscript([agentRow(agent("a1", 0, [text("Found three.")]))]);

      fireEvent.click(screen.getByRole("button", { name: "Message details" }));

      const popover = document.querySelector<HTMLElement>("[data-slot=popover-content]");
      expect(popover).toBeTruthy();
      expect(
        within(popover as HTMLElement).getByRole("button", { name: "Copy message" }),
      ).toBeTruthy();
      expect(within(popover as HTMLElement).getByTestId("feedback").dataset.turn).toBe("turn-1");
      expect((popover as HTMLElement).querySelector("time")).toBeTruthy();
    });

    it("offers a turn's feedback from its last bubble only", () => {
      renderTranscript([
        agentRow(agent("a1", 0, [text("On it.")]), agent("a2", 4_000, [text("Done.")])),
      ]);

      const [first, second] = screen.getAllByRole("button", { name: "Message details" });
      fireEvent.click(first);
      expect(screen.queryByTestId("feedback")).toBeNull();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      fireEvent.click(second);
      expect(screen.getByTestId("feedback")).toBeTruthy();
    });

    it("holds back feedback while the turn runs", () => {
      renderTranscript([agentRow(agent("a1", 0, [text("On it.")], "turn-1"))], {
        live: { ...idle, isStreaming: true, runningTurnId: "turn-1" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Message details" }));

      expect(screen.queryByTestId("feedback")).toBeNull();
      expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(1);
    });
  });

  describe("with touch", () => {
    beforeEach(() => stubHover(false));

    it("shows the details after a tap and hides them after another", () => {
      renderTranscript([agentRow(agent("a1", 0, [text("Found three.")]))]);
      expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();

      fireEvent.click(bubbleOf("Found three."));
      expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
      expect(screen.getByTestId("feedback")).toBeTruthy();
      expect(document.querySelector("time")).toBeTruthy();

      fireEvent.click(bubbleOf("Found three."));
      expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    });

    it("keeps a tap on a link for the link", () => {
      renderTranscript([
        agentRow(agent("a1", 0, [text("See [the docs](https://example.com/docs)")])),
      ]);

      fireEvent.click(screen.getByRole("link", { name: "the docs" }));

      expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    });

    it("keeps a tap that ends a text selection from toggling", () => {
      renderTranscript([agentRow(agent("a1", 0, [text("Found three.")]))]);
      const selection = rs.spyOn(window, "getSelection").mockReturnValue({
        isCollapsed: false,
      } as Selection);

      fireEvent.click(bubbleOf("Found three."));

      expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
      selection.mockRestore();
    });

    it("toggles from the more button for keyboards", () => {
      renderTranscript([agentRow(agent("a1", 0, [text("Found three.")]))]);
      const more = screen.getByRole("button", { name: "Message details" });
      expect(more.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(more);

      expect(more.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    });

    it("opens the guardian's own bubble the same way", () => {
      renderTranscript([userRow(guardian("u1", 0, "Find me a cafe"))]);
      expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();

      fireEvent.click(bubbleOf("Find me a cafe"));

      expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
      expect(screen.queryByTestId("feedback")).toBeNull();
    });
  });

  describe("bubble width", () => {
    beforeEach(() => stubHover(true));

    it("draws a long message as a normal bubble", () => {
      renderTranscript([
        agentRow(
          agent("a1", 0, [text("Short.")]),
          agent("a2", 3_000, [text("The long one.", "long")]),
        ),
      ]);

      const short = bubbleOf("Short.");
      const long = bubbleOf("The long one.");
      expect(long.className).toBe(short.className);
      for (const bubble of [short, long]) {
        const classes = bubble.className.split(/\s+/);
        expect(classes).toContain("w-fit");
        expect(classes).toContain("max-w-full");
        expect(classes).not.toContain("w-full");
        expect(classes).not.toContain("max-w-[80%]");
      }
    });

    it("drops the percentage cap from the guardian's bubble", () => {
      renderTranscript([userRow(guardian("u1", 0, "Hi"))]);

      expect(bubbleOf("Hi").className).not.toContain("max-w-[70%]");
    });
  });

  describe("the guardian's bubbles", () => {
    beforeEach(() => stubHover(true));

    it("show no avatar", () => {
      const sender = { kind: "guardian", name: "Ray", avatarUrl: null } as const;
      renderTranscript([userRow(guardian("u1", 0, "Hi", { sender }))]);

      expect(screen.queryByText("R")).toBeNull();
      expect(document.querySelector("[data-slot=avatar]")).toBeNull();
    });

    it("keep their delivery state", () => {
      renderTranscript([
        userRow(guardian("u1", 0, "Pending", { inputState: "queued" })),
        userRow(guardian("u2", 1_000, "Lost", { inputState: "failed" })),
      ]);

      expect(bubbleOf("Pending").getAttribute("aria-busy")).toBe("true");
      expect(bubbleOf("Pending").className).toContain("rome-bubble-pending");
      expect(bubbleOf("Lost").getAttribute("title")).toBe("Not delivered");
      expect(bubbleOf("Lost").className).toContain("border-destructive/50");
      expect(screen.getAllByRole("status").map((el) => el.textContent)).toContain(
        "Waiting to be included",
      );
    });
  });

  describe("grouping", () => {
    beforeEach(() => stubHover(true));

    const topLevel = (container: HTMLElement) =>
      Array.from(container.querySelector("[data-chat-transcript]")?.children ?? []);

    it("packs close bubbles of one sender and spaces the groups", () => {
      const { container } = renderTranscript([
        userRow(guardian("u1", 0, "One")),
        userRow(guardian("u2", 20_000, "Two")),
        agentRow(agent("a1", 40_000, [text("Reply A")]), agent("a2", 44_000, [text("Reply B")])),
      ]);

      const [separator, mine, theirs] = topLevel(container);
      expect(separator.tagName).toBe("P");
      expect(within(mine as HTMLElement).getByText("One")).toBeTruthy();
      expect(within(mine as HTMLElement).getByText("Two")).toBeTruthy();
      expect(within(theirs as HTMLElement).getByText("Reply A")).toBeTruthy();
      expect(within(theirs as HTMLElement).getByText("Reply B")).toBeTruthy();
      expect((mine as HTMLElement).className).toContain("gap-1");
      expect((mine as HTMLElement).parentElement?.className).toContain("gap-4");
    });

    it("adds a time line at fifteen minutes and splits the group at five", () => {
      const { container } = renderTranscript([
        userRow(guardian("u1", 0, "Morning")),
        userRow(guardian("u2", 6 * 60_000, "Later")),
        userRow(guardian("u3", 30 * 60_000, "Much later")),
      ]);

      const tags = topLevel(container).map((el) => el.tagName);
      // sep, group, group, sep, group
      expect(tags).toEqual(["P", "DIV", "DIV", "P", "DIV"]);
    });

    it("puts the typing bubble in the agent's group", () => {
      const { container } = renderTranscript([agentRow(agent("a1", 0, [text("One sec.")]))], {
        live: { ...idle, isStreaming: true, runningTurnId: "turn-1" },
      });

      const groups = topLevel(container).filter((el) => el.tagName === "DIV");
      expect(groups).toHaveLength(1);
      expect(within(groups[0] as HTMLElement).getByRole("status", { name: "Typing" })).toBeTruthy();
    });
  });
});

describe("Concierge reply", () => {
  beforeEach(() => stubHover(true));

  const draftOf = (overrides: Partial<ReplyDraft> = {}): ReplyDraft => ({
    sessionId: "concierge",
    target: null,
    set: rs.fn(),
    clear: rs.fn(),
    restore: rs.fn(),
    has: () => true,
    jump: rs.fn(),
    ...overrides,
  });
  const inChat = (draft: ReplyDraft, rows: ChatRow[]) =>
    render(
      <ReplyDraftProvider value={draft}>
        <ThemeProvider>
          <ConciergeTranscript
            rows={rows}
            live={idle}
            actions={actions}
            contentRef={() => {}}
            feedback
          />
        </ThemeProvider>
      </ReplyDraftProvider>,
    );
  const replyButtons = () => screen.getAllByRole("button", { name: "Reply" });

  it("puts Reply beside the more button, next to the bubble, and not in the menu", () => {
    const draft = draftOf();
    inChat(draft, [
      agentRow(
        agent("a1", 0, [text("First bubble.")]),
        agent("a2", 2_000, [text("Second bubble.")]),
      ),
    ]);

    const more = screen.getAllByRole("button", { name: "Message details" })[1];
    expect(more.parentElement?.firstElementChild).toBe(replyButtons()[1]);
    fireEvent.click(replyButtons()[1]);
    expect(draft.set).toHaveBeenCalledWith({
      messageId: "a2",
      author: "agent",
      preview: "Second bubble.",
    });

    fireEvent.click(more);
    const menu = document.querySelector("[data-slot=popover-content]") as HTMLElement;
    expect(within(menu).getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(within(menu).queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("puts Reply in the row a tap opens on touch", () => {
    stubHover(false);
    const draft = draftOf();
    inChat(draft, [agentRow(agent("a1", 0, [text("Found three.")]))]);
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();

    fireEvent.click(bubbleOf("Found three."));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(draft.set).toHaveBeenCalledWith(expect.objectContaining({ messageId: "a1" }));
    // The row closes once the reply is picked.
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
  });

  it("replies to a guardian bubble", () => {
    const draft = draftOf();
    inChat(draft, [userRow(guardian("u1", 0, "Find me a cafe", { inputState: "consumed" }))]);

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(draft.set).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "u1", author: "guardian", preview: "Find me a cafe" }),
    );
  });

  it("offers no Reply on a guardian bubble the agent has not taken in", () => {
    inChat(draftOf(), [userRow(guardian("u1", 0, "Find me a cafe", { inputState: "queued" }))]);

    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("gives a task chat card the same Reply, quoting it as one line", () => {
    const draft = draftOf();
    inChat(draft, [
      agentRow(agent("c1", 0, [{ type: "task_chat", chatId: "chat-7", title: "Trip" }])),
    ]);

    expect(screen.getByTestId("task-card")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Message details" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(draft.set).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "c1", preview: "[Task chat] Trip (chat chat-7)" }),
    );
  });

  it("makes each message the target of a jump from a quote of it", () => {
    const { container } = inChat(draftOf(), [
      userRow(guardian("u1", 0, "Hi")),
      agentRow(agent("a1", 2_000, [text("Hello.")])),
    ]);

    const anchors = [...container.querySelectorAll("[data-timeline-anchor]")].map((el) =>
      el.getAttribute("data-timeline-anchor"),
    );
    expect(anchors).toEqual(["u1", "a1"]);
  });

  it("offers no Reply where the chat has no reply state", () => {
    renderTranscript([agentRow(agent("a1", 0, [text("Found three.")]))]);

    fireEvent.click(screen.getByRole("button", { name: "Message details" }));

    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("shows a reply's quote above its text in the guardian's bubble", () => {
    inChat(draftOf(), [
      userRow(
        guardian("u2", 0, "ok", {
          content: JSON.stringify([
            { type: "reply_to", messageId: "a1", author: "agent", text: "Found three." },
            { type: "text", content: "ok" },
          ]),
        }),
      ),
    ]);

    expect(
      screen.getByRole("button", { name: "Go to the original message" }).textContent,
    ).toContain("Found three.");
  });
});
