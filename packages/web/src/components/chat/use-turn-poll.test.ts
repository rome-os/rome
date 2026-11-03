// @rstest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  TURN_POLL_AFTER_FOLLOW_MS,
  TURN_POLL_FALLBACK_MS,
  type TurnPollOutcome,
  useTurnPoll,
} from "./use-turn-poll";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const advance = (ms: number) =>
  act(async () => {
    await rs.advanceTimersByTimeAsync(ms);
  });

function renderPoll(
  poll: (sessionId: string) => Promise<TurnPollOutcome>,
  initial: { sessionId: string | null; paused: boolean; revision: number } = {
    sessionId: "session-1",
    paused: false,
    revision: 0,
  },
) {
  return renderHook(
    ({ sessionId, paused, revision }) => useTurnPoll(sessionId, { paused, revision }, poll),
    { initialProps: initial },
  );
}

describe("useTurnPoll", () => {
  beforeEach(() => {
    rs.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    rs.useRealTimers();
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it("looks on start, then only at the fallback cadence while idle", async () => {
    const poll = rs.fn(async (): Promise<TurnPollOutcome> => "idle");
    renderPoll(poll);
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith("session-1", expect.any(Function));

    await advance(60_000);
    expect(poll).toHaveBeenCalledTimes(1 + 60_000 / TURN_POLL_FALLBACK_MS);
  });

  it("looks at once on a kick, and once more after a look that a kick overlapped", async () => {
    let finish!: () => void;
    const poll = rs.fn(
      () =>
        new Promise<TurnPollOutcome>((resolve) => {
          finish = () => resolve("idle");
        }),
    );
    const { result } = renderPoll(poll);
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(1);

    act(() => {
      result.current();
      result.current();
    });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(poll).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    expect(poll).toHaveBeenCalledTimes(2);

    act(() => result.current());
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("stops the timer in a hidden tab, still answers kicks, and looks as it is shown", async () => {
    const poll = rs.fn(async (): Promise<TurnPollOutcome> => "idle");
    const { result } = renderPoll(poll);
    await advance(0);
    act(() => setVisibility("hidden"));
    await advance(5 * TURN_POLL_FALLBACK_MS);
    expect(poll).toHaveBeenCalledTimes(1);

    // A turn that starts in a hidden tab is still followed, so the tab badge shows it.
    act(() => result.current());
    await advance(5 * TURN_POLL_FALLBACK_MS);
    expect(poll).toHaveBeenCalledTimes(2);

    act(() => setVisibility("visible"));
    expect(poll).toHaveBeenCalledTimes(3);
    await advance(TURN_POLL_FALLBACK_MS);
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it("does nothing while paused or without a session, and looks when it resumes", async () => {
    const poll = rs.fn(async (): Promise<TurnPollOutcome> => "idle");
    const { result, rerender } = renderPoll(poll, {
      sessionId: "session-1",
      paused: true,
      revision: 0,
    });
    act(() => result.current());
    await advance(5 * TURN_POLL_FALLBACK_MS);
    expect(poll).not.toHaveBeenCalled();

    rerender({ sessionId: null, paused: false, revision: 0 });
    await advance(5 * TURN_POLL_FALLBACK_MS);
    expect(poll).not.toHaveBeenCalled();

    rerender({ sessionId: "session-1", paused: false, revision: 0 });
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(1);
    rerender({ sessionId: "session-1", paused: false, revision: 1 });
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("looks again soon after following a turn, for one queued behind it", async () => {
    const poll = rs
      .fn(async (): Promise<TurnPollOutcome> => "idle")
      .mockImplementationOnce(async () => "followed");
    renderPoll(poll);
    await advance(0);
    await advance(TURN_POLL_AFTER_FOLLOW_MS);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("treats a failed look as idle and keeps the fallback", async () => {
    const poll = rs
      .fn(async (): Promise<TurnPollOutcome> => "idle")
      .mockRejectedValueOnce(new Error("offline"));
    renderPoll(poll);
    await advance(0);
    await advance(TURN_POLL_FALLBACK_MS);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("stops for good on unmount, as when an Activity hides the chat", async () => {
    const poll = rs.fn(async (): Promise<TurnPollOutcome> => "idle");
    const { result, unmount } = renderPoll(poll);
    await advance(0);
    const kick = result.current;
    unmount();
    act(() => {
      kick();
      setVisibility("visible");
    });
    await advance(5 * TURN_POLL_FALLBACK_MS);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
