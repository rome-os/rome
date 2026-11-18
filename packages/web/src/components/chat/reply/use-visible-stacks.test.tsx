// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import "@/i18n";
import { chatThreadsOf, summariesOfLoaded, type ThreadTimelineMessage } from "./chat-threads";
import type { ChatMessage } from "@/lib/chat-types";
import { ThreadPills, waitingThreads } from "./ThreadPills";
import { useVisibleStacks } from "./use-visible-stacks";

// The pills say what the reader has not seen: a thread whose stack is in view
// needs none, and gets it back when the stack scrolls away still unread.

class FakeObserver {
  static all: FakeObserver[] = [];
  watched = new Set<Element>();
  disconnected = false;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {
    FakeObserver.all.push(this);
  }
  observe(element: Element) {
    this.watched.add(element);
  }
  disconnect() {
    this.disconnected = true;
    this.watched.clear();
  }
  /** Reports that `element` is `ratio` inside the root. */
  report(element: Element, ratio: number) {
    this.callback(
      [{ target: element, intersectionRatio: ratio, isIntersecting: ratio > 0 }] as never,
      this as never,
    );
  }
}
const live = () => FakeObserver.all.filter((observer) => !observer.disconnected);

beforeEach(() => {
  FakeObserver.all = [];
  rs.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

const say = (
  id: string,
  role: "user" | "assistant",
  thread: string,
  read?: boolean,
): ThreadTimelineMessage => ({
  id,
  role,
  chatThreadId: thread,
  chatThreadTitle: `Thread ${thread}`,
  ...(read === undefined ? {} : { read }),
});
// Two threads with an unread reply, and one whose replies are read.
const messages = [
  say("a", "user", "a"),
  say("a1", "assistant", "a", false),
  say("b", "user", "b"),
  say("b1", "assistant", "b", false),
  say("c", "user", "c"),
  say("c1", "assistant", "c", true),
];

function Harness({ list = messages }: { list?: ThreadTimelineMessage[] }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const threads = chatThreadsOf(list, null, true, {
    summaries: summariesOfLoaded(list as ChatMessage[]),
  });
  const visible = useVisibleStacks(scroller, content, waitingThreads(threads));
  return (
    <div ref={setScroller} data-testid="scroller">
      <div ref={setContent}>
        {[...threads.stacks.keys()].map((root) => (
          <button key={root} type="button" data-thread-stack={root} />
        ))}
      </div>
      <ThreadPills threads={threads} onPick={() => {}} visible={visible} />
    </div>
  );
}

const stack = (root: string) => document.querySelector(`[data-thread-stack="${root}"]`)!;
const pills = () =>
  [...document.querySelectorAll<HTMLElement>("[data-thread-pill]")].map(
    (pill) => pill.dataset.threadPill,
  );

describe("the pills and the stacks in view", () => {
  it("watches only the stacks of threads that wait, in the scroller's view", () => {
    render(<Harness />);
    const [observer] = live();
    expect(live()).toHaveLength(1);
    expect(observer?.options.root).toBe(screen.getByTestId("scroller"));
    expect([...observer!.watched]).toEqual([stack("a"), stack("b")]);
  });

  it("shows every waiting thread's pill until its stack is seen", () => {
    render(<Harness />);
    expect(pills()).toEqual(["a", "b"]);
  });

  it("takes the pill away while the stack is in view, and gives it back when the stack scrolls out", () => {
    render(<Harness />);
    const [observer] = live();

    act(() => observer!.report(stack("a"), 1));
    expect(pills()).toEqual(["b"]);

    act(() => observer!.report(stack("a"), 0));
    expect(pills()).toEqual(["a", "b"]);
  });

  it("counts a stack as seen from half inside the view", () => {
    render(<Harness />);
    const [observer] = live();
    act(() => observer!.report(stack("b"), 0.3));
    expect(pills()).toEqual(["a", "b"]);
    act(() => observer!.report(stack("b"), 0.5));
    expect(pills()).toEqual(["a"]);
  });

  it("marks nothing read: the thread stays unread, so its pill returns", () => {
    const { rerender } = render(<Harness />);
    act(() => live()[0]!.report(stack("a"), 1));
    expect(pills()).toEqual(["b"]);
    rerender(<Harness list={[...messages]} />);
    act(() => live().at(-1)!.report(stack("a"), 0));
    expect(pills()).toEqual(["a", "b"]);
  });

  it("watches a stack that starts waiting later, and lets go of one that was read", () => {
    const { rerender } = render(<Harness />);
    rerender(
      <Harness
        list={[
          ...messages.map((m) => (m.id === "b1" ? { ...m, read: true } : m)),
          say("c2", "assistant", "c", false),
        ]}
      />,
    );
    const [observer] = live();
    expect([...observer!.watched]).toEqual([stack("a"), stack("c")]);
    expect(pills()).toEqual(["a", "c"]);
  });

  it("has every pill when the browser cannot observe", () => {
    rs.stubGlobal("IntersectionObserver", undefined);
    render(<Harness />);
    expect(pills()).toEqual(["a", "b"]);
    fireEvent.click(document.querySelector("[data-thread-pill]")!);
  });
});
