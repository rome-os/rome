// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { resetTurnFeedbackForTest } from "@/lib/turn-feedback";
import { TurnFeedbackButtons } from "./TurnFeedbackButtons";

const autoPlaceApp = rs.fn();
rs.mock("@/pages/free/use-free-cells", () => ({
  autoPlaceApp: (...args: unknown[]) => autoPlaceApp(...args),
}));
rs.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

class InertIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
}

beforeEach(() => {
  rs.stubGlobal("IntersectionObserver", InertIntersectionObserver);
});

afterEach(() => {
  cleanup();
  resetTurnFeedbackForTest();
  autoPlaceApp.mockClear();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
});

/** An observer that reports its node in view as soon as it observes it. */
class VisibleIntersectionObserver extends InertIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {
    super();
  }
  override observe(target: Element) {
    queueMicrotask(() =>
      this.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      ),
    );
  }
}

describe("TurnFeedbackButtons", () => {
  it("reads a chat's feedback once for all its turns, and shows each turn's record", async () => {
    rs.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
    const fetchMock = rs.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        feedback: { "turn-2": { rating: "positive", comment: null, updatedAt: 1 } },
      }),
    );
    render(
      <>
        <TurnFeedbackButtons sessionId="chat-session" turnId="turn-1" />
        <TurnFeedbackButtons sessionId="chat-session" turnId="turn-2" />
        <TurnFeedbackButtons sessionId="chat-session" turnId="turn-3" />
      </>,
    );

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "message.feedback.recorded" })).toHaveLength(2),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/chat/sessions/chat-session/feedback");
    expect(screen.getAllByRole("button", { name: "message.feedback.thumbsUp" })).toHaveLength(2);
  });

  it("opens the feedback processing session returned by the server", async () => {
    const fetchMock = rs.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        feedback: { rating: "negative", comment: "Too long", updatedAt: 1 },
        processing: { appId: "sessions", route: "feedback-fork-session" },
      }),
    );
    render(<TurnFeedbackButtons sessionId="chat-session" turnId="turn-1" />);

    fireEvent.click(screen.getByRole("button", { name: "message.feedback.thumbsDown" }));
    fireEvent.change(screen.getByPlaceholderText("message.feedback.commentPlaceholder"), {
      target: { value: "Too long" },
    });
    fireEvent.click(screen.getByRole("button", { name: "message.feedback.submit" }));

    await waitFor(() => {
      expect(autoPlaceApp).toHaveBeenCalledWith(
        "sessions",
        "feedback-fork-session",
        undefined,
        true,
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/sessions/chat-session/turns/turn-1/feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ rating: "negative", comment: "Too long" }),
      }),
    );
  });
});
