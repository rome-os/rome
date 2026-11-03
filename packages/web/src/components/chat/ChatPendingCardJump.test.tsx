// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { ChatPendingCardJump } from "./ChatPendingCardJump";
import { RoutineDraftCard } from "./entries/RoutineDraftCard";
import { AiToolsCard } from "./entries/AiToolsCard";
import { QuestionCard } from "./entries/QuestionCard";
import { createRoutine, listRoutineRefs } from "@/lib/chat-api";
import i18n from "@/i18n";

rs.mock("@/lib/chat-api", () => ({
  createRoutine: rs.fn(),
  listRoutineRefs: rs.fn(),
}));

let cardTop = -200;
const scrollTo = rs.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

function Harness({
  questionResult,
  currentReplyMessageIds = new Set(["message"]),
  kind = "routine",
  aiResult,
}: {
  questionResult?: Record<string, unknown>;
  currentReplyMessageIds?: ReadonlySet<string>;
  kind?: "routine" | "app" | "ai" | "approval" | "question";
  aiResult?: Record<string, unknown>;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [floor, setFloor] = useState<HTMLDivElement | null>(null);
  return (
    <MemoryRouter>
      <div ref={setScroller} data-testid="scroller">
        <div ref={setContent}>
          <div data-chat-card-message="message">
            {kind === "approval" ? (
              <div data-chat-pending-card="approval">Pending approval</div>
            ) : kind === "app" ? (
              <div data-chat-pending-card="">App form</div>
            ) : kind === "ai" ? (
              <AiToolsCard toolUseId="ai" result={aiResult} onSubmit={() => {}} />
            ) : kind === "question" || questionResult ? (
              <QuestionCard
                toolUseId="question"
                props={{ questions: [{ id: "q", question: "When?", type: "text" }] }}
                result={questionResult?.resolved as Record<string, unknown> | undefined}
                onSubmit={() => {}}
                onDismiss={() => {}}
              />
            ) : (
              <RoutineDraftCard
                routineKey="chat-routine:test"
                draft={{
                  name: "Weekly update",
                  sentence: "Every Monday, remind me to send an update.",
                  watchLabel: "Mondays",
                  thenSummary: "Send a reminder",
                  trigger: { type: "manual" },
                  actionName: "summon",
                  args: {},
                }}
              />
            )}
          </div>
        </div>
        <div ref={setFloor} data-testid="floor">
          <ChatPendingCardJump
            scroller={scroller}
            content={content}
            floor={floor}
            currentReplyMessageIds={currentReplyMessageIds}
          />
        </div>
      </div>
    </MemoryRouter>
  );
}

beforeEach(() => {
  cardTop = -200;
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    Response.json(
      String(input) === "/api/ai-tools/status"
        ? { claude: { loggedIn: false }, codex: { loggedIn: false } }
        : String(input) === "/api/ai-tools/rome-credits"
          ? { credits: null }
          : { providers: [], configured: null },
    ),
  );
  rs.mocked(listRoutineRefs).mockResolvedValue([]);
  rs.mocked(createRoutine).mockResolvedValue({ ok: true, status: 201, routineId: "routine" });
  rs.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const top =
      this.dataset.testid === "scroller" ? 0 : this.dataset.testid === "floor" ? 500 : cardTop;
    const height = this.dataset.testid === "scroller" ? 600 : 100;
    return {
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: top,
      toJSON() {},
    };
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: (options: ScrollToOptions) => {
      scrollTo(options);
      cardTop = 0;
      fireEvent.scroll(screen.getByTestId("scroller"));
    },
  });
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  rs.restoreAllMocks();
  rs.clearAllMocks();
});

describe("ChatPendingCardJump", () => {
  for (const [language, visibleLabel] of [
    ["en", "Needs you"],
    ["zh-CN", "待你处理"],
  ]) {
    it(`starts its accessible name with the visible label in ${language}`, async () => {
      await i18n.changeLanguage(language);
      render(<Harness kind="app" />);
      const jump = await screen.findByText(visibleLabel);
      expect(screen.getByRole("button", { name: new RegExp(`^${visibleLabel}`) })).toBe(jump);
    });
  }

  it("keeps the reminder mounted and focused when the current reply is recomputed", async () => {
    const view = render(<Harness kind="app" currentReplyMessageIds={new Set(["message"])} />);
    const jump = await screen.findByRole("button", { name: "Needs you: jump to waiting card" });
    jump.focus();
    view.rerender(<Harness kind="app" currentReplyMessageIds={new Set(["message"])} />);
    expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBe(jump);
    expect(document.activeElement).toBe(jump);
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBe(jump);
    expect(document.activeElement).toBe(jump);
  });

  it("keeps a server-owned approval eligible even after a newer reply", async () => {
    render(<Harness kind="approval" currentReplyMessageIds={new Set(["other-message"])} />);
    await screen.findByRole("button", { name: "Needs you: jump to waiting card" });
  });
  for (const kind of ["routine", "app", "ai", "question"] as const) {
    it(`stops reminding about an ignored ${kind} when the current reply changes`, async () => {
      const view = render(<Harness kind={kind} />);
      await screen.findByRole("button", { name: "Needs you: jump to waiting card" });
      view.rerender(
        <Harness kind={kind} currentReplyMessageIds={new Set(["replacement-message"])} />,
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Needs you: jump to waiting card" }),
        ).toBeNull(),
      );
      expect(document.querySelector("[data-chat-pending-card]")).not.toBeNull();
      if (kind === "routine")
        expect(screen.getByRole("button", { name: "Turn it on" })).toBeTruthy();
    });
  }

  it("navigates to an AI connection card and stops after skipping", async () => {
    render(<Harness kind="ai" />);
    const jump = await screen.findByRole("button", { name: "Needs you: jump to waiting card" });
    fireEvent.click(jump);
    expect(scrollTo).toHaveBeenCalled();
    cardTop = -200;
    fireEvent.scroll(screen.getByTestId("scroller"));
    await screen.findByRole("button", { name: "Needs you: jump to waiting card" });
    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBeNull(),
    );
  });

  for (const result of [
    { connected: true },
    { connected: true, credits: true },
    { dismissed: true },
  ]) {
    it(`stops reminding about a resolved AI card (${JSON.stringify(result)})`, async () => {
      const view = render(<Harness kind="ai" />);
      await screen.findByRole("button", { name: "Needs you: jump to waiting card" });
      view.rerender(<Harness kind="ai" aiResult={result} />);
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Needs you: jump to waiting card" }),
        ).toBeNull(),
      );
    });
  }

  it("finds an unresolved routine above the viewport and brings it into view", async () => {
    render(<Harness />);
    const jump = await screen.findByRole("button", { name: "Needs you: jump to waiting card" });
    expect(document.querySelector("[data-chat-pending-card]")?.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(jump);
    expect(scrollTo).toHaveBeenCalledWith({ top: -200, behavior: "instant" });
    expect(document.activeElement?.hasAttribute("data-chat-pending-card")).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBeNull(),
    );
  });

  it("finds a card covered by the sticky composer even inside the scroller's bounds", async () => {
    cardTop = 510;
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Needs you: jump to waiting card" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 510, behavior: "instant" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBeNull(),
    );
  });

  it("hides while visible and after turning on the routine, including after reload", async () => {
    cardTop = 20;
    const view = render(<Harness />);
    await screen.findByRole("button", { name: "Turn it on" });
    expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBeNull();
    cardTop = -200;
    fireEvent.scroll(screen.getByTestId("scroller"));
    await screen.findByRole("button", { name: "Needs you: jump to waiting card" });
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBeNull(),
    );
    view.unmount();
    rs.mocked(listRoutineRefs).mockResolvedValue([
      { id: "routine", key: "chat-routine:test", name: "Weekly update", enabled: true },
    ]);
    render(<Harness />);
    await screen.findByText("On");
    expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBeNull();
  });

  for (const resolved of [
    { answers: [{ questionId: "q", value: "Monday" }] },
    { dismissed: true },
  ]) {
    it(`removes an off-screen question after ${"dismissed" in resolved ? "dismissal" : "an answer"}`, async () => {
      const view = render(<Harness questionResult={{}} />);
      await screen.findByRole("button", { name: "Needs you: jump to waiting card" });
      view.rerender(<Harness questionResult={{ resolved }} />);
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Needs you: jump to waiting card" }),
        ).toBeNull(),
      );
    });
  }
});
