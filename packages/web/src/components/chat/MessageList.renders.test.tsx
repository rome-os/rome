// @rstest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ComponentProps } from "react";
import * as messageRowModule from "@/components/chat/MessageRow" with { rstest: "importActual" };

// RomeLogo (the avatar fallback) renders an SVG mask that jsdom can't construct.
rs.mock("@/components/logo", () => ({
  RomeLogo: (props: Record<string, unknown>) => <div data-testid="rome-logo" {...props} />,
}));
rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: null, avatarUrl: null },
  }),
}));

// Every agent row draws one of these, so its renders are the agent rows' renders.
const drawn = rs.hoisted(() => ({ rows: 0 }));
rs.mock("@/components/chat/MessageRow", () => ({
  MessageRow: (props: ComponentProps<typeof messageRowModule.MessageRow>) => {
    drawn.rows += 1;
    return <messageRowModule.MessageRow {...props} />;
  },
}));

import { type AgentIdentity, buildRows } from "./chat-view";
import { MessageList, type BlockActions, type LivePreview } from "./MessageList";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { ThemeProvider } from "@/hooks/use-theme";
import { mergeChatMessage } from "@/lib/chat-message-ordering";
import type { ChatMessage } from "@/lib/chat-types";

afterEach(() => cleanup());

const IDENTITY: AgentIdentity = { name: "Agent", iconUrl: null };
const idle: LivePreview = {
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
const noop = () => {};

const MINUTE = 60_000;
const START = new Date(2026, 9, 27, 8, 0, 0).getTime();

function exchange(turn: number): ChatMessage[] {
  const turnId = `t${turn}`;
  const at = (step: number) => new Date(START + turn * 10 * MINUTE + step * 1_000).toISOString();
  return [
    {
      id: `u${turn}`,
      sessionId: "s-1",
      turnId,
      role: "user",
      content: JSON.stringify([{ type: "text", content: `question ${turn}` }]),
      createdAt: at(0),
    },
    {
      id: `a${turn}`,
      sessionId: "s-1",
      turnId,
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: `answer ${turn}` }]),
      createdAt: at(1),
    },
  ];
}

function list(messages: ChatMessage[]) {
  // The rows are rebuilt on every change to the messages, as the chat does.
  const rows = buildRows(messages, new Map([["s-1", IDENTITY]]), IDENTITY, {
    runningTurnId: null,
    isStreaming: false,
  });
  return (
    <ThemeProvider>
      <MessageList
        rows={rows}
        live={idle}
        contentRef={noop}
        onOpenLiveTrace={noop}
        onOpenStoredTrace={noop}
        actions={actions}
      />
    </ThemeProvider>
  );
}

describe("MessageList when a message arrives", () => {
  it("draws only the new row, not the 40 turns already on screen", () => {
    const messages = Array.from({ length: 40 }, (_, turn) => exchange(turn)).flat();
    const { container, rerender } = render(list(messages));
    expect(container.querySelectorAll("[data-timeline-anchor]")).toHaveLength(80);
    drawn.rows = 0;

    const arrived = mergeChatMessage(messages, exchange(40)[1]);
    rerender(list(arrived));

    // The new agent row: one draw. Rows that are rebuilt on every message drew all 41.
    expect(drawn.rows).toBeLessThanOrEqual(1);
    expect(container.textContent).toContain("answer 40");
  });

  it("keeps every other message as it was when one is merged in", () => {
    const messages = Array.from({ length: 5 }, (_, turn) => exchange(turn)).flat();

    const merged = mergeChatMessage(messages, exchange(5)[0]);

    messages.forEach((message) => expect(merged).toContain(message));
    expect(merged).toHaveLength(messages.length + 1);
  });
});
