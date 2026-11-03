// @rstest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { createLiveTextSource, staticLiveText } from "@/hooks/live-text";
import { ThemeProvider } from "@/hooks/use-theme";
import { useStreamingSessions } from "@/hooks/use-streaming-sessions";
import { LiveTail } from "./LiveTail";
import type { BlockActions, LivePreview } from "./MessageList";
import "@/i18n";

afterEach(cleanup);

const actions: BlockActions = {
  onApprovalResolved: () => {},
  onSubmitAppComponent: () => {},
  onDismissAppComponent: () => {},
  interactionResults: new Map(),
};

describe("LiveTail", () => {
  function preview(store: ReturnType<typeof createLiveTextSource>, blockIx = 0): LivePreview {
    return {
      isStreaming: true,
      runningTurnId: "turn-1",
      snapshot: null,
      textStore: store,
      blockIx,
      identity: { name: "Agent", iconUrl: null },
    };
  }

  it("types out the text the stream delivers, and renders nothing around it for each delivery", async () => {
    const store = createLiveTextSource();
    store.open("turn-1");
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return (
        <ThemeProvider>
          <LiveTail live={preview(store)} actions={actions} />
        </ThemeProvider>
      );
    }
    render(<Parent />);
    parentRenders = 0;

    act(() => {
      for (let i = 1; i <= 50; i++) store.set("turn-1", 0, `${"word ".repeat(i)}`.trim());
    });

    // The reveal runs at about a hundred characters a second.
    await waitFor(
      () => expect(document.body.textContent).toContain(`${"word ".repeat(50)}`.trim()),
      { timeout: 5_000 },
    );
    expect(parentRenders).toBe(0);
  });

  it("starts the next block from nothing, without a frame of the last block's text", async () => {
    const store = createLiveTextSource();
    store.open("turn-1");
    render(
      <ThemeProvider>
        <LiveTail live={preview(store)} actions={actions} />
      </ThemeProvider>,
    );
    act(() => store.set("turn-1", 0, "The first block."));
    await waitFor(() => expect(document.body.textContent).toContain("The first block."));

    act(() => store.set("turn-1", 1, ""));

    expect(document.body.textContent).not.toContain("The first block.");
  });

  it("shows a static text at once, with no typing", () => {
    render(
      <ThemeProvider>
        <LiveTail
          live={{ ...preview(createLiveTextSource()), textStore: staticLiveText("Hello there") }}
          actions={actions}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("Hello there")).toBeTruthy();
  });
});

describe("useStreamingSessions", () => {
  it("renders its host for a turn's start and block changes, not for each delivery of text", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useStreamingSessions();
    });

    act(() => result.current.start("session", "turn"));
    act(() => result.current.updateText("session", "turn", 0, "first"));
    renders = 0;

    act(() => {
      for (let i = 0; i < 400; i++) result.current.updateText("session", "turn", 0, `token ${i}`);
    });
    expect(renders).toBeLessThanOrEqual(1);
    expect(result.current.liveText("session").get().text).toBe("token 399");

    act(() => result.current.updateText("session", "turn", 1, "next block"));
    expect(renders).toBeLessThanOrEqual(3);
    expect(result.current.streams.get("session")?.assistantBlockIx).toBe(1);
  });

  it("clears the live text when the turn ends, and ignores a stale turn's text", () => {
    const { result } = renderHook(() => useStreamingSessions());
    act(() => result.current.start("session", "turn-1"));
    act(() => result.current.updateText("session", "turn-1", 0, "typing"));
    expect(result.current.liveText("session").get().text).toBe("typing");

    act(() => result.current.start("session", "turn-2"));
    act(() => result.current.updateText("session", "turn-1", 0, "stale reader"));
    expect(result.current.liveText("session").get().text).toBe("");

    act(() => result.current.end("session", "turn-2"));
    expect(result.current.liveText("session").get()).toEqual({ key: "idle", text: "" });
  });
});
