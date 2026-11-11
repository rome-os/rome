// @rstest-environment jsdom
import { cleanup, render } from "@testing-library/react";
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
  message("thanks", "user", 1),
  message("you're welcome", "assistant", 1),
];

function transcript(reactions: LiveStatusReactions = new Map()) {
  const rows = buildRows(messages, new Map(), IDENTITY, {
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
    expect(badges(container)).toEqual([["weather", "working", "👀"]]);
  });

  it("follows the live reaction once one arrives", () => {
    const { container, rerender } = render(transcript());
    rerender(transcript(new Map([["weather", "done"]])));
    expect(badges(container)).toEqual([["weather", "done", "✅"]]);
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
      ["thanks", "working", "👀"],
    ]);
    rerender(transcript(new Map([["weather", null]])));
    expect(badges(container)).toEqual([]);
  });

  it("reads the live event the server sends, and refuses a value it does not know", () => {
    const event = { sessionId: "concierge", messageId: "weather", statusReaction: "done" };
    expect(messageStatusReactionSchema.parse(event)).toEqual(event);
    expect(
      messageStatusReactionSchema.safeParse({ ...event, statusReaction: "thumbs_up" }).success,
    ).toBe(false);
  });
});
