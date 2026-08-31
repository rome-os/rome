// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
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
  autoPlaceApp.mockClear();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
});

describe("TurnFeedbackButtons", () => {
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
      expect(autoPlaceApp).toHaveBeenCalledWith("sessions", "feedback-fork-session");
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
