// @rstest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
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
interface Seen {
  scrollTop: () => number;
  isAtBottom: () => boolean;
  loadOlder?: (sessionId: string, options?: { through?: string }) => Promise<void>;
}

function Harness({
  initial,
  initialStuck,
  seen,
  focused,
}: {
  initial: ChatMessage[];
  initialStuck: boolean;
  seen: Seen;
  focused: boolean;
}) {
  const [messages, setMessages] = useState(new Map([["s1", initial]]));
  const [onDemand, setOnDemand] = useState(focused);
  const [satisfied, setSatisfied] = useState(false);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const stick = useStickToBottom({ initialStuck });
  const older = useOlderMessages("s1", {
    pageTurns: 7,
    scroller,
    pinned: stick.isAtBottom,
    setMessages,
    onDemand,
    satisfied,
  });
  const { setCursor } = older;
  useEffect(() => setCursor("s1", "cursor-1"), [setCursor]);
  const rows = messages.get("s1") ?? [];
  seen.isAtBottom = () => stick.isAtBottom;
  seen.loadOlder = older.loadOlder;
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
      <button type="button" data-testid="end-focus" onClick={() => setOnDemand(false)} />
      <button type="button" data-testid="satisfy" onClick={() => setSatisfied(true)} />
      {older.hasOlder("s1") ? <div ref={older.sentinelRef} data-testid="sentinel" /> : null}
      <div ref={stick.contentRef}>
        {rows.map((row) => (
          <p key={row.id}>{row.id}</p>
        ))}
      </div>
    </div>
  );
}

function renderHarness(initial: ChatMessage[], initialStuck = false, focused = false) {
  const seen: Seen = { scrollTop: () => 0, isAtBottom: () => initialStuck };
  render(<Harness initial={initial} initialStuck={initialStuck} seen={seen} focused={focused} />);
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

  it("reads through a message once the page in flight is in", async () => {
    let finish!: (page: { messages: ChatMessage[]; nextCursor: string }) => void;
    rs.mocked(listSessionMessagePage)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ messages: [message("m1", 1)], nextCursor: null });
    const seen = renderHarness([message("m3", 3)]);

    let through!: Promise<void>;
    await act(async () => {
      void seen.loadOlder?.("s1");
      through = seen.loadOlder!("s1", { through: "m1" });
    });
    await act(async () => finish({ messages: [message("m2", 2)], nextCursor: "cursor-2" }));
    await act(async () => through);

    expect(rs.mocked(listSessionMessagePage).mock.calls[1]).toEqual([
      "s1",
      { limit: 7, before: "cursor-2", through: "m1" },
    ]);
    expect(shownIds()).toEqual(["m1", "m2", "m3"]);
  });
});

describe("useOlderMessages onOlderPage", () => {
  it("reports the messages of each older page that loads, and no other", async () => {
    const page = [message("m1", 1), message("m2", 2)];
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce({ messages: page, nextCursor: null });
    const onOlderPage = rs.fn();
    const { result } = renderHook(() =>
      useOlderMessages("s1", {
        pageTurns: 7,
        scroller: null,
        pinned: true,
        setMessages: () => {},
        onOlderPage,
      }),
    );
    act(() => result.current.setCursor("s1", "cursor-1"));
    expect(onOlderPage).not.toHaveBeenCalled();
    await act(() => result.current.loadOlder("s1"));
    expect(onOlderPage).toHaveBeenCalledExactlyOnceWith("s1", page);
  });
});

describe("useOlderMessages on demand", () => {
  const scroller = () => screen.getByTestId("scroller");
  const wheelUp = () => fireEvent.wheel(scroller(), { deltaY: -40 });
  const pages = () => rs.mocked(listSessionMessagePage).mock.calls.length;
  // Long enough for one gesture to end.
  const idle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
  const twoPages = () =>
    rs
      .mocked(listSessionMessagePage)
      .mockResolvedValueOnce({ messages: [message("m2", 2)], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ messages: [message("m1", 1)], nextCursor: null });

  it("loads nothing by itself: the sentinel stays quiet however near the view it is", async () => {
    renderHarness([message("m3", 3)], false, true);
    await act(async () => {});
    expect(FakeIntersectionObserver.live()).toHaveLength(0);
    expect(pages()).toBe(0);
  });

  it("loads one page for a push up against the top, however many events the gesture has", async () => {
    twoPages();
    renderHarness([message("m3", 3)], false, true);

    await act(async () => {
      wheelUp();
      wheelUp();
      wheelUp();
    });
    await waitFor(() => expect(shownIds()).toEqual(["m2", "m3"]));
    // Momentum after the page landed is the same gesture.
    await act(async () => wheelUp());

    expect(pages()).toBe(1);
  });

  it("needs a new gesture for the next page, and then loads exactly that one", async () => {
    twoPages();
    renderHarness([message("m3", 3)], false, true);
    await act(async () => wheelUp());
    await waitFor(() => expect(shownIds()).toEqual(["m2", "m3"]));

    await idle();
    expect(pages()).toBe(1);
    // The page pushed the reader down by its height: back up to the top.
    expect(scroller().scrollTop).toBeGreaterThan(0);
    scroller().scrollTop = 0;
    await act(async () => wheelUp());

    await waitFor(() => expect(shownIds()).toEqual(["m1", "m2", "m3"]));
    expect(pages()).toBe(2);
    expect(rs.mocked(listSessionMessagePage).mock.calls.map((call) => call[1].before)).toEqual([
      "cursor-1",
      "cursor-2",
    ]);
  });

  it("judges a gesture by when its events happened, not when a busy page handled them", async () => {
    twoPages();
    renderHarness([message("m3", 3)], false, true);
    // A wheel event as the browser stamped it, handled late.
    const wheelAt = (stamp: number) => {
      const event = new WheelEvent("wheel", { deltaY: -40, bubbles: true });
      Object.defineProperty(event, "timeStamp", { value: stamp });
      scroller().dispatchEvent(event);
    };

    await act(async () => wheelAt(1000));
    await waitFor(() => expect(shownIds()).toEqual(["m2", "m3"]));
    scroller().scrollTop = 0;
    // Handled 400 ms later, but it happened 100 ms after the first: the same gesture.
    await idle();
    await act(async () => wheelAt(1100));
    expect(pages()).toBe(1);

    // Happened 400 ms after the last one: a new gesture.
    await act(async () => wheelAt(1500));
    await waitFor(() => expect(shownIds()).toEqual(["m1", "m2", "m3"]));
    expect(pages()).toBe(2);
  });

  it("asks nothing of a push away from the top, or a scroll down", async () => {
    renderHarness([message("m3", 3)], false, true);
    scroller().scrollTop = 300;
    await act(async () => wheelUp());
    scroller().scrollTop = 0;
    await act(async () => fireEvent.wheel(scroller(), { deltaY: 40 }));
    expect(pages()).toBe(0);
  });

  it("loads on a pull down on a touch screen, once for the touch", async () => {
    twoPages();
    renderHarness([message("m3", 3)], false, true);

    await act(async () => {
      fireEvent.touchStart(scroller(), { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(scroller(), { touches: [{ clientY: 140 }] });
      fireEvent.touchMove(scroller(), { touches: [{ clientY: 190 }] });
    });
    await waitFor(() => expect(shownIds()).toEqual(["m2", "m3"]));
    // A swipe up is no pull.
    await act(async () => {
      fireEvent.touchStart(scroller(), { touches: [{ clientY: 300 }] });
      fireEvent.touchMove(scroller(), { touches: [{ clientY: 200 }] });
    });

    expect(pages()).toBe(1);
  });

  it("loads on PageUp, Home and the up arrow, but not in a field or on a held key", async () => {
    twoPages();
    renderHarness([message("m3", 3)], false, true);
    const field = document.body.appendChild(document.createElement("textarea"));

    await act(async () => fireEvent.keyDown(field, { key: "ArrowUp" }));
    await act(async () => fireEvent.keyDown(document.body, { key: "PageUp", repeat: true }));
    await act(async () => fireEvent.keyDown(document.body, { key: "End" }));
    expect(pages()).toBe(0);

    await act(async () => fireEvent.keyDown(document.body, { key: "Home" }));
    await waitFor(() => expect(shownIds()).toEqual(["m2", "m3"]));
    expect(pages()).toBe(1);
    field.remove();
  });

  it("loads nothing once the reader has all they can want, as with the thread's first message in", async () => {
    twoPages();
    renderHarness([message("m3", 3)], false, true);
    await act(async () => screen.getByTestId("satisfy").click());

    await act(async () => wheelUp());
    await act(async () => fireEvent.keyDown(document.body, { key: "Home" }));
    await act(async () => {
      fireEvent.touchStart(scroller(), { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(scroller(), { touches: [{ clientY: 200 }] });
    });

    expect(pages()).toBe(0);
  });

  it("leaves a key that something used first, such as an arrow in a menu", async () => {
    twoPages();
    renderHarness([message("m3", 3)], false, true);
    const menu = document.body.appendChild(document.createElement("div"));
    menu.addEventListener("keydown", (event) => event.preventDefault());

    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
      );
    });
    expect(pages()).toBe(0);

    await act(async () => fireEvent.keyDown(document.body, { key: "ArrowUp" }));
    expect(pages()).toBe(1);
    menu.remove();
  });

  it("hands the paging back to the sentinel when the focus ends", async () => {
    renderHarness([message("m3", 3)], false, true);
    expect(FakeIntersectionObserver.live()).toHaveLength(0);

    await act(async () => screen.getByTestId("end-focus").click());

    expect(FakeIntersectionObserver.live()).toHaveLength(1);
    // And a wheel is no longer a request.
    await act(async () => wheelUp());
    expect(pages()).toBe(0);
  });
});
