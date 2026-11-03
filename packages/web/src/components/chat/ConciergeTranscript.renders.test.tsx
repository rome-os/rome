// @rstest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ComponentProps } from "react";
import * as metaModule from "@/components/chat/ConciergeMessageMeta" with {
  rstest: "importActual",
};

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: null, avatarUrl: null },
  }),
}));

// Every bubble draws one of these, so its renders are the bubbles' renders.
const drawn = rs.hoisted(() => ({ meta: 0 }));
rs.mock("@/components/chat/ConciergeMessageMeta", () => ({
  ConciergeMessageMeta: (props: ComponentProps<typeof metaModule.ConciergeMessageMeta>) => {
    drawn.meta += 1;
    return <metaModule.ConciergeMessageMeta {...props} />;
  },
}));

import { type AgentIdentity, buildRows } from "./chat-view";
import { ConciergeTranscript } from "./ConciergeTranscript";
import type { BlockActions, LivePreview } from "./MessageList";
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

const HOUR = 3_600_000;
const START = new Date(2026, 9, 27, 8, 0, 0).getTime();
const at = (turn: number, step = 0) => new Date(START + turn * HOUR + step * 10_000).toISOString();

function exchange(turn: number): ChatMessage[] {
  const turnId = `t${turn}`;
  return [
    {
      id: `u${turn}`,
      sessionId: "concierge",
      turnId,
      role: "user",
      content: JSON.stringify([{ type: "text", content: `question ${turn}` }]),
      createdAt: at(turn),
    },
    {
      id: `a${turn}`,
      sessionId: "concierge",
      turnId,
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: `answer ${turn}` }]),
      createdAt: at(turn, 1),
    },
  ];
}

// The same message objects every time, the way the chat keeps its transcript;
// only the rows and what is built from them are new.
const messages = Array.from({ length: 40 }, (_, turn) => exchange(turn)).flat();

function transcript(list: ChatMessage[]) {
  const rows = buildRows(list, new Map(), IDENTITY, { runningTurnId: null, isStreaming: false });
  return (
    <ThemeProvider>
      <ConciergeTranscript rows={rows} live={live} actions={actions} contentRef={() => {}} />
    </ThemeProvider>
  );
}

describe("ConciergeTranscript when a message arrives", () => {
  it("draws only the new bubble, not the 80 already on screen", () => {
    const { container, rerender } = render(transcript(messages));
    expect(container.querySelectorAll("[data-concierge-bubble]")).toHaveLength(40);

    drawn.meta = 0;
    rerender(transcript([...messages, ...exchange(40).slice(0, 1)]));

    // The guardian's new bubble: one draw. A rebuilt transcript drew all 81.
    expect(drawn.meta).toBeLessThanOrEqual(2);
    expect(container.textContent).toContain("question 40");
  });

  it("still brings the new bubble in and leaves the old ones as they were", () => {
    const { container, rerender } = render(transcript(messages));
    expect(container.querySelectorAll("[data-arrival]")).toHaveLength(0);

    rerender(transcript([...messages, ...exchange(40)]));

    const entering = Array.from(container.querySelectorAll<HTMLElement>("[data-arrival]")).map(
      (el) => el.dataset.timelineAnchor ?? el.textContent?.trim(),
    );
    expect(entering).toEqual(["u40", "answer 40"]);
  });

  it("draws the older page once when history is paged in above the transcript", () => {
    const { rerender } = render(transcript(messages.slice(20)));
    drawn.meta = 0;

    rerender(transcript(messages));

    // 10 new exchanges: 20 bubbles, and the 40 that were there stay put.
    expect(drawn.meta).toBeLessThanOrEqual(20);
  });
});
