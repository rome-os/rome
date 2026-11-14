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
import { type LiveReactions, LiveReactionsProvider, messageReactionSchema } from "./reaction";
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
  message("weather", "user", 0, { reaction: "👀" }),
  message("quoted", "user", 0, {
    reaction: "👀",
    content: JSON.stringify([
      { type: "reply_to", messageId: "weather", author: "guardian", text: "weather" },
      { type: "text", content: "And tomorrow?" },
    ]),
  }),
  message("thanks", "user", 1),
  message("you're welcome", "assistant", 1),
];

function transcript(reactions: LiveReactions = new Map(), shown = messages) {
  const rows = buildRows(shown, new Map(), IDENTITY, {
    runningTurnId: null,
    isStreaming: false,
  });
  return (
    <ThemeProvider>
      <LiveReactionsProvider value={reactions}>
        <ConciergeTranscript rows={rows} live={live} actions={actions} contentRef={() => {}} />
      </LiveReactionsProvider>
    </ThemeProvider>
  );
}

const badges = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-reaction]")).map((badge) => [
    badge.closest<HTMLElement>("[data-timeline-anchor]")?.dataset.timelineAnchor,
    badge.textContent,
  ]);

describe("Concierge reaction", () => {
  it("draws a badge on the guardian's bubble from the message's field, and none elsewhere", () => {
    const { container } = render(transcript());
    expect(badges(container)).toEqual([
      ["weather", "👀"],
      ["quoted", "👀"],
    ]);
  });

  it("draws whatever string the server sends, not only the Concierge's set", () => {
    const { container } = render(
      transcript(new Map(), [
        message("odd", "user", 0, { reaction: "🦄" }),
        message("long", "user", 1, { reaction: "ok" }),
      ]),
    );
    expect(badges(container)).toEqual([
      ["odd", "🦄"],
      ["long", "ok"],
    ]);
  });

  it("sits inside the colored bubble, a bubble with a reply quote too, not beside it in the row", () => {
    const { container } = render(transcript());
    const placed = Array.from(container.querySelectorAll<HTMLElement>("[data-reaction]"));
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

  it("draws the emoji in a round badge on the bubble's top-left corner, with a thought dot, and only shows", () => {
    const { container } = render(transcript());
    const badge = container.querySelector<HTMLElement>("[data-reaction]");
    expect(badge).not.toBeNull();
    const classes = badge?.className.split(/\s+/) ?? [];
    // A 28px badge centered on the top-left corner, so half of it hangs out.
    expect(classes).toEqual(
      expect.arrayContaining(["absolute", "-top-3.5", "-left-3.5", "size-7", "rounded-full"]),
    );
    // Lighter than the page in both themes, through semantic tokens only.
    expect(classes).toEqual(
      expect.arrayContaining(["bg-surface-elevated", "dark:bg-surface-hover", "shadow-1"]),
    );
    expect(classes.some((name) => /^(right|bottom|-right|-bottom)-/.test(name))).toBe(false);
    // One small dot trails off its lower left, hidden from assistive tech.
    const dot = badge?.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(dot?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["absolute", "size-1.5", "rounded-full", "-left-0.5", "top-6"]),
    );
    // Neither shrunk nor dimmed: the emoji keeps its own colors.
    expect(classes.some((name) => /^(scale-|opacity-)/.test(name))).toBe(false);
    expect(badge?.querySelector("[class*='opacity-']")).toBeNull();
    // It is an image with a name, and takes no pointer.
    expect(badge?.getAttribute("role")).toBe("img");
    // One generic name, whatever the emoji.
    expect(badge?.getAttribute("aria-label")).toBe("Reaction");
    expect(badge?.getAttribute("title")).toBe("Reaction");
    expect(classes).toContain("pointer-events-none");
  });

  it("keeps the same room above every guardian bubble, mark or not, and none above the agent's", () => {
    const { container } = render(transcript());
    const box = (id: string) =>
      container.querySelector<HTMLElement>(`[data-timeline-anchor="${id}"]`)?.className ?? "";
    const room = (className: string) => className.match(/\bmt-[\w.]+/g) ?? [];
    // "weather" has a mark, "thanks" has none: the same room either way.
    expect(room(box("weather"))).toEqual(["mt-4"]);
    expect(room(box("thanks"))).toEqual(["mt-4"]);
    expect(room(box("you're welcome"))).toEqual([]);
  });

  it("follows the live reaction once one arrives", async () => {
    const { container, rerender } = render(transcript());
    // A new reaction replaces the loaded one.
    rerender(transcript(new Map([["weather", "✅"]])));
    expect(badges(container)).toEqual([
      ["weather", "✅"],
      ["quoted", "👀"],
    ]);
    rerender(
      transcript(
        new Map([
          ["weather", "✅"],
          ["thanks", "❤️"],
        ]),
      ),
    );
    expect(badges(container)).toEqual([
      ["weather", "✅"],
      ["quoted", "👀"],
      ["thanks", "❤️"],
    ]);
    rerender(
      transcript(
        new Map([
          ["weather", null],
          ["quoted", null],
          ["thanks", "❤️"],
        ]),
      ),
    );
    // A reaction that is cleared fades out first, then leaves.
    expect(
      Array.from(container.querySelectorAll("[data-reaction]"))
        .filter((badge) => badge.textContent !== "❤️")
        .every((badge) => badge.hasAttribute("data-leaving")),
    ).toBe(true);
    await waitFor(() => expect(badges(container)).toEqual([["thanks", "❤️"]]));
  });

  it("gives each of the owner's consecutive messages its own reaction", () => {
    const run = [
      message("lime", "user", 5, { reaction: "👀" }),
      message("chat", "user", 5),
      message("sum", "user", 6, { reaction: "👍" }),
    ];
    const { container, rerender } = render(transcript(new Map(), run));
    expect(badges(container)).toEqual([
      ["lime", "👀"],
      ["sum", "👍"],
    ]);
    rerender(transcript(new Map([["chat", "🙏"]]), run));
    expect(badges(container)).toEqual([
      ["lime", "👀"],
      ["chat", "🙏"],
      ["sum", "👍"],
    ]);
  });

  it("reads the live event the server sends, any string or null", () => {
    const event = { sessionId: "concierge", messageId: "weather", reaction: "👍" };
    expect(messageReactionSchema.parse(event)).toEqual(event);
    expect(messageReactionSchema.parse({ ...event, reaction: null })).toEqual({
      ...event,
      reaction: null,
    });
    expect(messageReactionSchema.parse({ ...event, reaction: "🦄" }).reaction).toBe("🦄");
    expect(messageReactionSchema.safeParse({ ...event, reaction: 7 }).success).toBe(false);
  });
});
