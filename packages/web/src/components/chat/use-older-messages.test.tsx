// @rstest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { listSessionMessagePage } from "@/lib/chat-api";
import type { ChatMessage } from "@/lib/chat-types";
import { scrollTopAfterPrepend, useOlderMessages } from "./use-older-messages";

rs.mock("@/lib/chat-api", () => ({ listSessionMessagePage: rs.fn() }));

const ROW_HEIGHT = 100;
const VIEWPORT = 400;

function message(id: string, minute: number): ChatMessage {
  return {
    id,
    sessionId: "s1",
    turnId: `turn-${id}`,
    role: "user",
    content: "[]",
    createdAt: new Date(Date.UTC(2026, 9, 27, 12, minute)).toISOString(),
  };
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  disconnected = false;
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
  report(isIntersecting: boolean) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as never);
  }
  static live() {
    return FakeIntersectionObserver.instances.filter((observer) => !observer.disconnected);
  }
}

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** A scroller whose height follows its row count, since jsdom lays nothing out. */
function Harness({
  initial,
  initialStuck,
  seen,
}: {
  initial: ChatMessage[];
  initialStuck: boolean;
  seen: { scrollTop: () => number; isAtBottom: () => boolean };
}) {
  const [messages, setMessages] = useState(new Map([["s1", initial]]));
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const stick = useStickToBottom({ initialStuck });
  const older = useOlderMessages("s1", {
    pageTurns: 7,
    scroller,
    pinned: stick.isAtBottom,
    setMessages,
  });
  const { setCursor } = older;
  useEffect(() => setCursor("s1", "cursor-1"), [setCursor]);
  const rows = messages.get("s1") ?? [];
  seen.isAtBottom = () => stick.isAtBottom;
  return (
    <div
      data-testid="scroller"
      ref={(node) => {
        if (node && !node.dataset.fake) {
          node.dataset.fake = "1";
          let top = 0;
          Object.defineProperty(node, "scrollTop", {
            get: () => top,
            set: (value: number) => {
              top = value;
            },
          });
          Object.defineProperty(node, "scrollHeight", {
            get: () => node.querySelectorAll("p").length * ROW_HEIGHT,
          });
          Object.defineProperty(node, "clientHeight", { get: () => VIEWPORT });
          node.scrollTo = ((options: ScrollToOptions) => {
            top = options.top ?? 0;
          }) as typeof node.scrollTo;
          seen.scrollTop = () => top;
        }
        setScroller(node);
        stick.scrollRef(node);
      }}
    >
      {older.hasOlder("s1") ? <div ref={older.sentinelRef} data-testid="sentinel" /> : null}
      <div ref={stick.contentRef}>
        {rows.map((row) => (
          <p key={row.id}>{row.id}</p>
        ))}
      </div>
    </div>
  );
}

function renderHarness(initial: ChatMessage[], initialStuck = false) {
  const seen = { scrollTop: () => 0, isAtBottom: () => initialStuck };
  render(<Harness initial={initial} initialStuck={initialStuck} seen={seen} />);
  return seen;
}

function shownIds() {
  return screen.getAllByText(/^m\d+$/).map((node) => node.textContent);
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  rs.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  rs.stubGlobal("ResizeObserver", FakeResizeObserver);
  rs.mocked(listSessionMessagePage).mockReset();
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

describe("scrollTopAfterPrepend", () => {
  it("moves down by the height the older rows added", () => {
    expect(
      scrollTopAfterPrepend(
        { scrollTop: 120, scrollHeight: 1000 },
        { scrollTop: 120, scrollHeight: 1600 },
      ),
    ).toBe(720);
  });

  it("keeps a position the browser already moved", () => {
    expect(
      scrollTopAfterPrepend(
        { scrollTop: 120, scrollHeight: 1000 },
        { scrollTop: 720, scrollHeight: 1600 },
      ),
    ).toBe(720);
  });
});

describe("useOlderMessages", () => {
  it("loads the page before the cursor when the sentinel comes into range, in order", async () => {
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce({
      messages: [message("m1", 1), message("m2", 2)],
      nextCursor: null,
    });
    renderHarness([message("m3", 3), message("m4", 4)]);
    expect(shownIds()).toEqual(["m3", "m4"]);

    await act(async () => FakeIntersectionObserver.live().at(-1)?.report(true));

    await waitFor(() => expect(shownIds()).toEqual(["m1", "m2", "m3", "m4"]));
    expect(listSessionMessagePage).toHaveBeenCalledWith("s1", { limit: 7, before: "cursor-1" });
  });

  it("stops observing once the oldest page has loaded", async () => {
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce({
      messages: [message("m1", 1)],
      nextCursor: null,
    });
    renderHarness([message("m2", 2)]);

    await act(async () => FakeIntersectionObserver.live().at(-1)?.report(true));

    await waitFor(() => expect(screen.queryByTestId("sentinel")).toBeNull());
    expect(FakeIntersectionObserver.live()).toHaveLength(0);
  });

  it("follows the cursor of each page back through the history", async () => {
    rs.mocked(listSessionMessagePage)
      .mockResolvedValueOnce({ messages: [message("m2", 2)], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ messages: [message("m1", 1)], nextCursor: null });
    renderHarness([message("m3", 3)]);

    await act(async () => FakeIntersectionObserver.live().at(-1)?.report(true));
    await waitFor(() => expect(shownIds()).toEqual(["m2", "m3"]));
    await act(async () => FakeIntersectionObserver.live().at(-1)?.report(true));

    await waitFor(() => expect(shownIds()).toEqual(["m1", "m2", "m3"]));
    expect(rs.mocked(listSessionMessagePage).mock.calls.map((call) => call[1].before)).toEqual([
      "cursor-1",
      "cursor-2",
    ]);
  });

  it("keeps the viewport on the same content when older rows are inserted above it", async () => {
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce({
      messages: [message("m1", 1), message("m2", 2), message("m3", 3)],
      nextCursor: null,
    });
    const seen = renderHarness([message("m4", 4), message("m5", 5)]);
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTop = 40;

    await act(async () => FakeIntersectionObserver.live().at(-1)?.report(true));

    await waitFor(() => expect(shownIds()).toHaveLength(5));
    expect(seen.scrollTop()).toBe(40 + 3 * ROW_HEIGHT);
  });

  it("does not pin the viewport to the bottom when older rows are inserted", async () => {
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce({
      messages: [message("m1", 1), message("m2", 2)],
      nextCursor: null,
    });
    const seen = renderHarness([message("m3", 3), message("m4", 4)]);
    screen.getByTestId("scroller").scrollTop = 10;
    expect(seen.isAtBottom()).toBe(false);

    await act(async () => FakeIntersectionObserver.live().at(-1)?.report(true));

    await waitFor(() => expect(shownIds()).toHaveLength(4));
    expect(seen.isAtBottom()).toBe(false);
    expect(seen.scrollTop()).toBe(10 + 2 * ROW_HEIGHT);
  });

  it("leaves a pinned viewport to the stick-to-bottom hook", async () => {
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce({
      messages: [message("m1", 1), message("m2", 2)],
      nextCursor: null,
    });
    const seen = renderHarness([message("m3", 3)], true);
    screen.getByTestId("scroller").scrollTop = 0;

    await act(async () => FakeIntersectionObserver.live().at(-1)?.report(true));

    await waitFor(() => expect(shownIds()).toHaveLength(3));
    expect(seen.scrollTop()).toBe(0);
  });

  it("asks for a page once while one is in flight", async () => {
    let finish!: (page: { messages: ChatMessage[]; nextCursor: null }) => void;
    rs.mocked(listSessionMessagePage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderHarness([message("m2", 2)]);
    const observer = FakeIntersectionObserver.live().at(-1);

    await act(async () => {
      observer?.report(true);
      observer?.report(true);
    });
    await act(async () => finish({ messages: [message("m1", 1)], nextCursor: null }));

    expect(listSessionMessagePage).toHaveBeenCalledTimes(1);
  });
});
