// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
// Real bundles, so the hide control's accessible name is the shipped
// string rather than its key — the same thing a screen reader would read.
import "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatTimelineRail } from "./ChatTimelineRail";
import type { TimelineQuestion } from "./chat-timeline";

beforeEach(() => {
  rs.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  rs.useRealTimers();
  cleanup();
  localStorage.clear();
});

const QUESTIONS: TimelineQuestion[] = [
  { messageId: "q1", text: "how do I ship this?" },
  { messageId: "q2", text: "what broke the build?" },
  { messageId: "q3", text: "why is it slow?" },
  { messageId: "q4", text: "can we cache it?" },
];

// The markers, excluding the hide control — which is a button too, but is
// deliberately focusable and is not one of the questions. Hidden markers stay
// mounted so the retract animates, and leave the a11y tree via aria-hidden —
// which is exactly what getAllByRole filters on.
function markers(): HTMLElement[] {
  return screen.getAllByRole("button").filter((el) => el.getAttribute("aria-expanded") === null);
}

function rect(top: number, height = 0): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

// jsdom has no layout: every rect is zero and scrollHeight/clientHeight are 0,
// which would trip the rail's gates before any of its wiring ran. Stub the
// metrics so what is under test is the component's own behaviour; the geometry
// itself is covered with plain numbers in chat-timeline.test.ts.
function stubScroller(anchors: Array<{ id: string; top: number }>): HTMLElement {
  const scroller = document.createElement("div");
  for (const anchor of anchors) {
    const el = document.createElement("div");
    el.setAttribute("data-timeline-anchor", anchor.id);
    el.getBoundingClientRect = () => rect(anchor.top);
    scroller.appendChild(el);
  }
  scroller.getBoundingClientRect = () => rect(0, 600);
  Object.defineProperty(scroller, "scrollHeight", { value: 3000, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(scroller, "scrollTop", { value: 0, writable: true, configurable: true });
  document.body.appendChild(scroller);
  return scroller;
}

const SPREAD_ANCHORS = [
  { id: "q1", top: 0 },
  { id: "q2", top: 600 },
  { id: "q3", top: 1200 },
  { id: "q4", top: 1800 },
];

/**
 * Render, then give the track a height and re-run the measurement.
 *
 * The track's own `clientHeight` drives the layout (that is what keeps the
 * computed and painted positions in one coordinate space), and jsdom reports 0
 * for it until it is stubbed — which cannot happen before the first render. The
 * second pass hands the effect a fresh `questions` identity so it re-measures
 * against the stubbed height, which is the path that ships.
 */
function renderRail(
  scroller: HTMLElement | null,
  questions: TimelineQuestion[],
  onJump: (messageId: string) => void = () => {},
) {
  // The rail lives inside Chat's single TooltipProvider (Chat.tsx), which owns
  // the shared hover delay — it deliberately does not nest one of its own.
  const view = render(
    <TooltipProvider>
      <ChatTimelineRail
        scroller={scroller}
        content={scroller}
        questions={questions}
        onJump={onJump}
      />
    </TooltipProvider>,
  );
  const track = view.container.querySelector<HTMLElement>("[data-timeline-track]");
  if (track) Object.defineProperty(track, "clientHeight", { value: 500, configurable: true });
  view.rerender(
    <TooltipProvider>
      <ChatTimelineRail
        scroller={scroller}
        content={scroller}
        questions={[...questions]}
        onJump={onJump}
      />
    </TooltipProvider>,
  );
  return view;
}

describe("ChatTimelineRail", () => {
  it("renders one bar per question, labelled with its text", () => {
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
    expect(markers()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "how do I ship this?" })).toBeTruthy();
  });

  it("jumps to the question a marker points at", () => {
    const onJump = rs.fn();
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS, onJump);
    fireEvent.click(screen.getByRole("button", { name: "what broke the build?" }));
    expect(onJump).toHaveBeenCalledWith("q2");
  });

  it("keeps a compact rhythm regardless of message positions", () => {
    const onJump = rs.fn();
    renderRail(
      stubScroller([
        { id: "q1", top: 0 },
        { id: "q2", top: 4 },
        { id: "q3", top: 8 },
        { id: "q4", top: 12 },
      ]),
      QUESTIONS,
      onJump,
    );
    expect(markers().map((marker) => marker.style.top)).toEqual([
      "238px",
      "246px",
      "254px",
      "262px",
    ]);
    const navigation = screen.getByRole("navigation", { name: "Question timeline" });
    expect(navigation.className).toContain("left-0");
    expect(markers()[0].className).toContain("left-4");
    fireEvent.click(screen.getByRole("button", { name: "can we cache it?" }));
    expect(onJump).toHaveBeenCalledWith("q4");
  });

  it("takes one tab stop for the whole column", () => {
    // Search cannot scroll to a message yet, so the rail is the only keyboard
    // route to an earlier question — but forty questions must not mean forty
    // tab stops. Exactly one marker is tabbable; arrows reach the rest.
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
    expect(markers().map((marker) => marker.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
      "-1",
    ]);
    expect(
      screen.getByRole("button", { name: "Hide timeline" }).getAttribute("tabindex"),
    ).toBeNull();
  });

  it("moves between questions with the arrow keys", () => {
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
    const all = markers();
    all[0].focus();

    fireEvent.keyDown(all[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(all[1]);
    expect(markers().map((marker) => marker.getAttribute("tabindex"))).toEqual([
      "-1",
      "0",
      "-1",
      "-1",
    ]);

    fireEvent.keyDown(all[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(all[0]);

    fireEvent.keyDown(all[0], { key: "End" });
    expect(document.activeElement).toBe(all[3]);

    fireEvent.keyDown(all[3], { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
  });

  it("stops at the ends rather than wrapping", () => {
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
    const all = markers();
    all[0].focus();
    fireEvent.keyDown(all[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(all[0]);

    all[3].focus();
    fireEvent.keyDown(all[3], { key: "ArrowDown" });
    expect(document.activeElement).toBe(all[3]);
  });

  it("takes hidden markers out of the tab order", () => {
    // They stay mounted so the retract animates, and carry aria-hidden — which
    // must never contain something focusable.
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
    fireEvent.click(screen.getByRole("button", { name: "Hide timeline" }));
    const hiddenMarkers = [
      ...document.querySelectorAll<HTMLElement>("[data-timeline-markers] button"),
    ];
    expect(hiddenMarkers).toHaveLength(4);
    for (const marker of hiddenMarkers) {
      expect(marker.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("renders no markers below the question floor", () => {
    const { container } = renderRail(
      stubScroller(SPREAD_ANCHORS.slice(0, 2)),
      QUESTIONS.slice(0, 2),
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders no markers when the transcript fits on one screen", () => {
    const scroller = stubScroller(SPREAD_ANCHORS);
    Object.defineProperty(scroller, "scrollHeight", { value: 700, configurable: true });
    const { container } = renderRail(scroller, QUESTIONS);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders no markers without a scroller", () => {
    const { container } = renderRail(null, QUESTIONS);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("hides the markers and offers to bring them back", () => {
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
    expect(markers()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Hide timeline" }).style.top).toBe("214px");

    fireEvent.click(screen.getByRole("button", { name: "Hide timeline" }));
    expect(markers()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Show timeline" }));
    expect(markers()).toHaveLength(4);
  });

  it("remembers a hide across mounts", () => {
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
    fireEvent.click(screen.getByRole("button", { name: "Hide timeline" }));
    cleanup();

    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
    expect(markers()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Show timeline" })).toBeTruthy();
  });

  it("repositions the show control when the track resizes while hidden", () => {
    let fire: (() => void) | null = null;
    const RealRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private readonly callback: () => void;

      constructor(callback: () => void) {
        this.callback = callback;
        fire = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {
        if (fire === this.callback) fire = null;
      }
    } as unknown as typeof ResizeObserver;

    try {
      const { container } = renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
      expect(screen.getByRole("button", { name: "Hide timeline" }).style.top).toBe("214px");

      fireEvent.click(screen.getByRole("button", { name: "Hide timeline" }));
      const track = container.querySelector<HTMLElement>("[data-timeline-track]");
      expect(track).not.toBeNull();
      Object.defineProperty(track, "clientHeight", { value: 200, configurable: true });

      act(() => {
        fire?.();
        rs.advanceTimersByTime(200);
      });
      expect(screen.getByRole("button", { name: "Show timeline" }).style.top).toBe("64px");
    } finally {
      globalThis.ResizeObserver = RealRO;
    }
  });

  it("keeps watching while hidden with nothing to show", () => {
    // A hidden rail that measured nothing — too narrow, too short — must stay
    // subscribed, or becoming eligible later leaves no Show control until the
    // next message or a reload.
    const observed: Element[] = [];
    let fire: (() => void) | null = null;
    const RealRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      localStorage.setItem("rome-timeline-hidden", "1");
      // A transcript under two viewports: ineligible, so nothing is measured.
      const scroller = stubScroller(SPREAD_ANCHORS);
      Object.defineProperty(scroller, "scrollHeight", { value: 700, configurable: true });
      renderRail(scroller, QUESTIONS);
      expect(screen.queryByRole("button")).toBeNull();
      expect(observed.length).toBeGreaterThan(0);

      // It grows past the threshold; the observer has to bring the control back.
      Object.defineProperty(scroller, "scrollHeight", { value: 3000, configurable: true });
      act(() => {
        fire?.();
        rs.advanceTimersByTime(200);
      });
      expect(screen.getByRole("button", { name: "Show timeline" })).toBeTruthy();
    } finally {
      globalThis.ResizeObserver = RealRO;
    }
  });

  it("offers no control when there is no timeline to hide", () => {
    renderRail(stubScroller(SPREAD_ANCHORS.slice(0, 2)), QUESTIONS.slice(0, 2));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
