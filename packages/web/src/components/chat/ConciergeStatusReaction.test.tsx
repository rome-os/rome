// @rstest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: null, avatarUrl: null },
  }),
}));

import { type AgentIdentity, buildRows } from "./chat-view";
import { ConciergeTranscript } from "./ConciergeTranscript";
import type { BlockActions, LivePreview } from "./MessageList";
import {
  type LiveStatusReactions,
  LiveStatusReactionsProvider,
  messageStatusReactionSchema,
} from "./status-reaction";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { ThemeProvider } from "@/hooks/use-theme";
import type { ChatMessage } from "@/lib/chat-types";

beforeEach(() => {
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

const IDENTITY: AgentIdentity = { name: "Concierge", iconUrl: null };
const live: LivePreview = {
  isStreaming: false,
  runningTurnId: null,
  snapshot: null,
  textStore: EMPTY_LIVE_TEXT,
  identity: IDENTITY,
};
const actions: BlockActions = {
  onApprovalResolved: () => {},
  onSubmitAppComponent: () => {},
  onDismissAppComponent: () => {},
  interactionResults: new Map(),
};

const message = (
  id: string,
  role: "user" | "assistant",
  turn: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  sessionId: "concierge",
  turnId: `t${turn}`,
  role,
  content: JSON.stringify([{ type: "text", content: id }]),
  createdAt: new Date(2026, 10, 11, 8, turn, role === "user" ? 0 : 10).toISOString(),
  ...extra,
});

const messages: ChatMessage[] = [
  message("weather", "user", 0, { statusReaction: "working" }),
  message("quoted", "user", 0, {
    statusReaction: "working",
    content: JSON.stringify([
      { type: "reply_to", messageId: "weather", author: "guardian", text: "weather" },
      { type: "text", content: "And tomorrow?" },
    ]),
  }),
  message("thanks", "user", 1),
  message("you're welcome", "assistant", 1),
];

function transcript(reactions: LiveStatusReactions = new Map(), shown = messages) {
  const rows = buildRows(shown, new Map(), IDENTITY, {
    runningTurnId: null,
    isStreaming: false,
  });
  return (
    <ThemeProvider>
      <LiveStatusReactionsProvider value={reactions}>
        <ConciergeTranscript rows={rows} live={live} actions={actions} contentRef={() => {}} />
      </LiveStatusReactionsProvider>
    </ThemeProvider>
  );
}

const badges = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-status-reaction]")).map((badge) => [
    badge.closest<HTMLElement>("[data-timeline-anchor]")?.dataset.timelineAnchor,
    badge.dataset.statusReaction,
    badge.textContent,
  ]);

describe("Concierge status reaction", () => {
  it("draws a badge on the guardian's bubble from the message's field, and none elsewhere", () => {
    const { container } = render(transcript());
    expect(badges(container)).toEqual([
      ["weather", "working", "👀"],
      ["quoted", "working", "👀"],
    ]);
  });

  it("sits inside the colored bubble, a bubble with a reply quote too, not beside it in the row", () => {
    const { container } = render(transcript());
    const placed = Array.from(container.querySelectorAll<HTMLElement>("[data-status-reaction]"));
    expect(placed).toHaveLength(2);
    for (const badge of placed) {
      const bubble = badge.parentElement;
      expect(bubble?.hasAttribute("data-chat-bubble")).toBe(true);
      // The bubble is the badge's positioned ancestor.
      expect(bubble?.className).toMatch(/\brelative\b/);
      // The mark takes no room: the bubble keeps its normal spacing.
      expect(bubble?.className).not.toMatch(/\bm[by]-/);
    }
  });

  it("follows the live reaction once one arrives", async () => {
    const { container, rerender } = render(transcript());
    rerender(transcript(new Map([["weather", "failed"]])));
    expect(badges(container)).toEqual([
      ["weather", "failed", "⚠️"],
      ["quoted", "working", "👀"],
    ]);
    rerender(
      transcript(
        new Map([
          ["weather", "failed"],
          ["thanks", "working"],
        ]),
      ),
    );
    expect(badges(container)).toEqual([
      ["weather", "failed", "⚠️"],
      ["quoted", "working", "👀"],
      ["thanks", "working", "👀"],
    ]);
    rerender(
      transcript(
        new Map([
          ["weather", null],
          ["quoted", null],
        ]),
      ),
    );
    // A mark that goes fades out first, then leaves.
    expect(
      Array.from(container.querySelectorAll("[data-status-reaction]")).every((badge) =>
        badge.hasAttribute("data-leaving"),
      ),
    ).toBe(true);
    await waitFor(() => expect(badges(container)).toEqual([]));
  });

  it("gives each of the owner's consecutive messages its own mark", () => {
    const run = [
      message("lime", "user", 5, { statusReaction: "working" }),
      message("chat", "user", 5),
      message("sum", "user", 6, { statusReaction: "failed" }),
    ];
    const { container, rerender } = render(transcript(new Map(), run));
    // A question answered at once shows nothing, though the task above works on.
    expect(badges(container)).toEqual([
      ["lime", "working", "👀"],
      ["sum", "failed", "⚠️"],
    ]);
    rerender(transcript(new Map([["chat", "working"]]), run));
    expect(badges(container)).toEqual([
      ["lime", "working", "👀"],
      ["chat", "working", "👀"],
      ["sum", "failed", "⚠️"],
    ]);
  });

  it("reads the live event the server sends, and refuses a value it does not know", () => {
    const event = { sessionId: "concierge", messageId: "weather", statusReaction: "failed" };
    expect(messageStatusReactionSchema.parse(event)).toEqual(event);
    expect(messageStatusReactionSchema.parse({ ...event, statusReaction: null })).toEqual({
      ...event,
      statusReaction: null,
    });
    // Finished work shows no mark, so there is no "done".
    expect(
      messageStatusReactionSchema.safeParse({ ...event, statusReaction: "done" }).success,
    ).toBe(false);
    expect(
      messageStatusReactionSchema.safeParse({ ...event, statusReaction: "thumbs_up" }).success,
    ).toBe(false);
  });
});
