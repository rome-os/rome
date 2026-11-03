// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ChatMessage } from "@/lib/chat-types";
import "@/i18n";
import { HOLD_STICK_EVENT } from "@/hooks/use-stick-to-bottom";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { ThemeProvider } from "@/hooks/use-theme";
import { ConciergeTranscript } from "./ConciergeTranscript";
import type { ChatRow } from "./chat-view";
import type { BlockActions, LivePreview } from "./MessageList";
import { ReplyDraftProvider, type ReplyDraft } from "./reply/reply-draft";

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: "Ray", avatarUrl: null },
  }),
}));

// jsdom has no layout. A node is as tall as its text: 20px for each 40
// characters, the height of a 14px line that holds about that many. A message
// is cut when its content is taller than 20rem + 3rem = 368px (jsdom's rem is
// the 16px fallback).
const heightOf = (node: Node) => Math.ceil((node.textContent?.length ?? 0) / 40) * 20;

/** A message of `count` paragraphs, 40 characters each. */
const paragraphs = (count: number, label = "Line") =>
  Array.from({ length: count }, (_, index) => `${label} ${index + 1}`.padEnd(40, ".")).join("\n\n");
const LONG = paragraphs(20); // 400px, over the 368px threshold
const JUST_UNDER = paragraphs(18); // 360px: taller than the 20rem cut, under the slack
const SHORT = "Found three.";

beforeEach(() => {
  rs.stubGlobal("IntersectionObserver", undefined);
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return heightOf(this);
    },
  });
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
  rs.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
});

const SENT_AT = new Date(2026, 9, 28, 12, 5, 0).toISOString();

function agent(id: string, parts: unknown[], turnId = "turn-1"): ChatMessage {
  return {
    id,
    sessionId: "concierge",
    turnId,
    role: "assistant",
    content: JSON.stringify(parts),
    createdAt: SENT_AT,
  } as ChatMessage;
}

const agentRow = (...messages: ChatMessage[]): ChatRow =>
  ({
    kind: "agent",
    key: messages[0].id,
    identity: { name: "Rome", iconUrl: null },
    trace: null,
    messages,
  }) as ChatRow;

const guardianRow = (id: string, turnId: string): ChatRow => ({
  kind: "user",
  key: id,
  message: {
    id,
    sessionId: "concierge",
    turnId,
    role: "user",
    content: JSON.stringify([{ type: "text", content: "Find it" }]),
    createdAt: SENT_AT,
  } as ChatMessage,
});

const text = (content: string, extra: Record<string, unknown> = {}) => ({
  type: "text",
  content,
  ...extra,
});

const actions = {
  onApprovalResolved: () => {},
  onSubmitAppComponent: () => {},
  onDismissAppComponent: () => {},
  interactionResults: new Map(),
} as BlockActions;

const idle = {
  isStreaming: false,
  runningTurnId: null,
  snapshot: null,
  textStore: EMPTY_LIVE_TEXT,
  identity: { name: "Rome", iconUrl: null },
} as LivePreview;

const draftOf = (): ReplyDraft => ({
  sessionId: "concierge",
  target: null,
  set: rs.fn(),
  clear: rs.fn(),
  restore: rs.fn(),
  has: () => true,
  jump: rs.fn(),
});

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function transcript(rows: ChatRow[], draft: ReplyDraft = draftOf()) {
  return (
    <MemoryRouter>
      <ReplyDraftProvider value={draft}>
        <ThemeProvider>
          <ConciergeTranscript rows={rows} live={idle} actions={actions} contentRef={() => {}} />
        </ThemeProvider>
      </ReplyDraftProvider>
      <Location />
    </MemoryRouter>
  );
}

const toggles = () => screen.queryAllByRole("button", { name: /^Show (full text|less)$/ });
const region = (toggle: HTMLElement) =>
  document.getElementById(toggle.getAttribute("aria-controls") ?? "") as HTMLElement;

describe("Concierge long message collapse", () => {
  it("cuts a message taller than the threshold and keeps all of its text in the page", () => {
    render(transcript([agentRow(agent("a1", [text(LONG)]))]));

    const [toggle] = toggles();
    expect(toggle.textContent).toBe("Show full text");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(region(toggle).style.maxHeight).toBe("20rem");
    expect(region(toggle).className).toContain("overflow-hidden");
    // Clipped, not removed: the browser's find and a text selection still reach it.
    expect(within(region(toggle)).getByText(/^Line 20\.+$/)).toBeTruthy();
  });

  it("opens and closes it from one button that switches its label", () => {
    render(transcript([agentRow(agent("a1", [text(LONG)]))]));

    fireEvent.click(toggles()[0]);
    const [open] = toggles();
    expect(open.textContent).toBe("Show less");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(region(open).style.maxHeight).toBe("");
    expect(region(open).className).not.toContain("overflow-hidden");

    fireEvent.click(open);
    const [closed] = toggles();
    expect(closed.textContent).toBe("Show full text");
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    expect(region(closed).style.maxHeight).toBe("20rem");
  });

  it("fades the cut with an overlay that blocks no pointer, and drops it when open", () => {
    render(transcript([agentRow(agent("a1", [text(LONG)]))]));
    const fade = () =>
      region(toggles()[0]).querySelector<HTMLElement>("[aria-hidden=true].absolute.bottom-0");

    expect(fade()?.className).toContain("pointer-events-none");
    expect(fade()?.className).toContain("from-surface-muted");

    fireEvent.click(toggles()[0]);

    expect(fade()).toBeNull();
  });

  it("puts no overflow container on an open message, or on one that needs no cut", () => {
    render(transcript([agentRow(agent("a1", [text(LONG)]), agent("a2", [text(SHORT)]))]));
    fireEvent.click(toggles()[0]);

    // The sticky controls of a code block stick to the transcript, not to a clip.
    expect(document.querySelector(".overflow-hidden[id]")).toBeNull();
    expect(document.querySelector("[style*=max-height]")).toBeNull();
  });

  it("cuts on content height alone, with a few rem of slack", () => {
    render(transcript([agentRow(agent("a1", [text(JUST_UNDER)]), agent("a2", [text(LONG)]))]));

    // 360px is taller than 20rem but within 3rem of it: one bar for the second only.
    expect(toggles()).toHaveLength(1);
    expect(region(toggles()[0]).textContent).toContain("Line 20");
  });

  it("leaves a short message as it is", () => {
    render(transcript([agentRow(agent("a1", [text(SHORT)]))]));

    expect(toggles()).toHaveLength(0);
    expect(document.querySelector("[style*=max-height]")).toBeNull();
    expect(document.querySelector(".overflow-hidden[id]")).toBeNull();
  });

  describe("the toggle's place", () => {
    // The bar under the content, and anything before the content (the pill's wrapper).
    const slots = (toggle: HTMLElement) => {
      const root = region(toggle).parentElement as HTMLElement;
      return Array.from(root.children).map((child) => ({
        tag: child.tagName,
        id: child.id,
        isBar: child.contains(toggle),
        pill: child.classList.contains("sticky"),
      }));
    };

    it("is the same bar in the same slot, cut or open, so opening moves nothing", () => {
      render(transcript([agentRow(agent("a1", [text(LONG)]))]));
      const cut = slots(toggles()[0]);

      fireEvent.click(toggles()[0]);

      const open = slots(toggles()[0]);
      // A zero-height marker, the content, then the bar: the same slots, with nothing added above the content.
      expect(open.map((slot) => ({ ...slot, id: "" }))).toEqual(
        cut.map((slot) => ({ ...slot, id: "" })),
      );
      expect(open.map((slot) => slot.isBar)).toEqual([false, false, true]);
      expect(open.some((slot) => slot.pill)).toBe(false);
    });

    describe("while the open message's bar is off screen", () => {
      // Two observers watch an open message: one on the bar, one on the top edge.
      let bar: (visible: boolean) => void;
      let top: (above: boolean) => void;
      beforeEach(() => {
        rs.stubGlobal(
          "IntersectionObserver",
          class {
            callback: (entries: unknown[]) => void;
            constructor(callback: (entries: unknown[]) => void) {
              this.callback = callback;
            }
            observe(target: Element) {
              if (target.tagName === "BUTTON") {
                bar = (isIntersecting) => this.callback([{ isIntersecting }]);
              } else {
                top = (above) =>
                  this.callback([
                    {
                      isIntersecting: !above,
                      boundingClientRect: { top: above ? -500 : 100 },
                      rootBounds: { top: 48 },
                    },
                  ]);
              }
            }
            unobserve() {}
            disconnect() {}
          },
        );
      });
      const pill = () =>
        Array.from(document.querySelectorAll<HTMLElement>("button[aria-hidden=true]")).find(
          (button) => /Show less/.test(button.textContent ?? ""),
        );
      const deepInside = () => {
        fireEvent.click(toggles()[0]);
        act(() => {
          bar(false);
          top(true);
        });
      };

      it("floats a Show less pill that takes no room", () => {
        render(transcript([agentRow(agent("a1", [text(LONG)]))]));
        fireEvent.click(toggles()[0]);
        expect(pill()).toBeUndefined();

        act(() => {
          bar(false);
          top(true);
        });

        const floating = pill() as HTMLElement;
        const wrapper = floating.parentElement?.parentElement as HTMLElement;
        // A sticky, zero-height wrapper, and the pill positioned inside it.
        expect(wrapper.className).toContain("sticky");
        expect(wrapper.className).toContain("h-0");
        expect(floating.parentElement?.className).toContain("absolute");
        expect(floating.parentElement?.className).toContain("right-0");
        // Above the content, where it can cover no layout.
        expect(wrapper.nextElementSibling).toBe(region(toggles()[0]));
      });

      it("waits while the top of the message is in view, so it covers no first line", () => {
        render(transcript([agentRow(agent("a1", [text(LONG)]))]));
        fireEvent.click(toggles()[0]);

        act(() => {
          bar(false);
          top(false);
        });

        expect(pill()).toBeUndefined();
      });

      it("is one toggle: the pill is out of the tab order and the bar stays the one button", () => {
        render(transcript([agentRow(agent("a1", [text(LONG)]))]));
        deepInside();

        const floating = pill() as HTMLElement;
        expect(floating.tabIndex).toBe(-1);
        expect(floating.getAttribute("aria-expanded")).toBe("true");
        expect(floating.getAttribute("aria-controls")).toBe(
          toggles()[0].getAttribute("aria-controls"),
        );
        expect(toggles()).toHaveLength(1);
      });

      it("closes the message from the pill, and goes away with it", () => {
        render(transcript([agentRow(agent("a1", [text(LONG)]))]));
        deepInside();

        fireEvent.click(pill() as HTMLElement);

        expect(toggles()[0].getAttribute("aria-expanded")).toBe("false");
        expect(pill()).toBeUndefined();
      });

      it("is gone when the bar comes on screen", () => {
        render(transcript([agentRow(agent("a1", [text(LONG)]))]));
        deepInside();
        act(() => bar(true));

        expect(pill()).toBeUndefined();
      });
    });
  });

  it("keeps the choice of each message, and a new long message arrives cut", () => {
    const first = agent("a1", [text(LONG)]);
    const { rerender } = render(transcript([agentRow(first)]));
    fireEvent.click(toggles()[0]);

    rerender(transcript([agentRow(first, agent("a2", [text(paragraphs(20, "Other"))]))]));

    expect(toggles().map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual([
      "true",
      "false",
    ]);
  });

  it("starts a message from earlier history cut too, and leaves the open ones open", () => {
    // History pages by turn, and a turn starts with the guardian's message, so a
    // page of older turns is groups of its own.
    const newer = [guardianRow("u2", "turn-2"), agentRow(agent("a2", [text(LONG)], "turn-2"))];
    const { rerender } = render(transcript(newer));
    fireEvent.click(toggles()[0]);

    rerender(
      transcript([
        guardianRow("u0", "turn-0"),
        agentRow(agent("a0", [text(paragraphs(20, "Older"))], "turn-0")),
        ...newer,
      ]),
    );

    expect(toggles().map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual([
      "false",
      "true",
    ]);
  });

  describe("with a ResizeObserver", () => {
    // jsdom has no layout engine, so no observer ever reports. This one reports
    // the size of everything it watches when a test says a frame has passed.
    const observed = new Set<Element>();
    const created: Array<(entries: Array<{ target: Element }>) => void> = [];
    const frame = () =>
      act(() => {
        for (const report of created) report([...observed].map((target) => ({ target })));
      });
    beforeEach(() => {
      observed.clear();
      created.length = 0;
      rs.stubGlobal(
        "ResizeObserver",
        class {
          constructor(report: (entries: Array<{ target: Element }>) => void) {
            created.push(report);
          }
          observe(target: Element) {
            observed.add(target);
          }
          unobserve(target: Element) {
            observed.delete(target);
          }
          disconnect() {}
        },
      );
    });

    it("measures again when the content or its width changes", () => {
      render(transcript([agentRow(agent("a1", [text(SHORT)]))]));
      expect(toggles()).toHaveLength(0);

      // The text grows after the first paint, as an image or a wide table does.
      screen.getByText(SHORT).textContent = LONG;
      frame();

      expect(toggles()).toHaveLength(1);
    });

    it("cuts a long message in the commit that mounts it, not on a later frame", () => {
      render(transcript([agentRow(agent("a1", [text(LONG)]))]));

      // No frame has passed: the transcript pins itself to the bottom in this
      // commit, so a cut that waited for the observer would pin to the wrong heights.
      expect(toggles()).toHaveLength(1);
    });

    it("watches every bubble with one observer, and stops when they go", () => {
      const { unmount } = render(
        transcript([
          agentRow(
            agent("a1", [text(SHORT)]),
            agent("a2", [text(LONG)]),
            agent("a3", [text(SHORT)]),
          ),
        ]),
      );

      expect(created).toHaveLength(1);
      expect(observed.size).toBe(3);

      // Settled bubbles report again without a change, and nothing is redrawn.
      const reads = rs.fn();
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get(this: HTMLElement) {
          reads();
          return heightOf(this);
        },
      });
      frame();
      expect(toggles()).toHaveLength(1);
      expect(reads).toHaveBeenCalledTimes(3);

      unmount();
      expect(observed.size).toBe(0);
    });
  });

  it("opens when the browser's find scrolls the cut text into view", () => {
    render(transcript([agentRow(agent("a1", [text(LONG)]))]));
    const [toggle] = toggles();

    Object.defineProperty(region(toggle), "scrollTop", { configurable: true, value: 120 });
    fireEvent.scroll(region(toggle));

    expect(toggles()[0].getAttribute("aria-expanded")).toBe("true");
  });

  describe("keeping the bubble where it was", () => {
    // jsdom has no layout, so the page is a model. The bubble's top is at 700 on
    // the page and on screen at 700 minus the scroll, and the scroller's top
    // edge is at 48. `shift` is what the page does to the bubble on a toggle on
    // its own: the browser's scroll anchoring, a clamp, or content settling late.
    let shift = 0;
    let shiftWhenOpen = true;
    function pageWithScroller(scrollTop: number) {
      shift = 0;
      shiftWhenOpen = true;
      const scroller = document.createElement("div");
      scroller.style.overflowY = "auto";
      let top = scrollTop;
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
        },
      });
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 5000 });
      document.body.append(scroller);
      rs.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        let y = 0;
        if (this === scroller) y = 48;
        else if (this.hasAttribute("data-concierge-bubble")) {
          const open = document.querySelector("button[aria-controls][aria-expanded=true]") !== null;
          y = 700 + (open === shiftWhenOpen ? shift : 0) - top;
        }
        return { top: y, bottom: y, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
      });
      return scroller;
    }
    const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 60)));
    const press = () => {
      fireEvent.click(toggles()[0]);
    };

    it("puts the bubble's top back where it was when the message opens", async () => {
      const scroller = pageWithScroller(400);
      render(transcript([agentRow(agent("a1", [text(LONG)]))]), { container: scroller });
      shift = 30;
      shiftWhenOpen = true;

      press();
      await settle();

      // The page moved the top 30px down the screen; the transcript follows it.
      expect(scroller.scrollTop).toBe(430);
    });

    it("puts the bubble's top back where it was when the message closes with its top in view", async () => {
      const scroller = pageWithScroller(400);
      render(transcript([agentRow(agent("a1", [text(LONG)]))]), { container: scroller });
      press();
      await settle();
      shift = -25;
      shiftWhenOpen = false;

      press();
      await settle();

      expect(scroller.scrollTop).toBe(375);
    });

    it("brings the top of a bubble that closes from deep inside it to a step below the transcript's top edge", async () => {
      const scroller = pageWithScroller(400);
      render(transcript([agentRow(agent("a1", [text(LONG)]))]), { container: scroller });
      press();
      await settle();
      // Reading the middle: the top is 800px above the screen.
      scroller.scrollTop = 1500;
      shift = 0;

      press();
      await settle();

      // 700 - 1500 = -800 on screen before; it ends at 48 + 16.
      expect(700 - scroller.scrollTop).toBe(48 + 16);
    });

    it("does not snap a bubble that opens with its top above the screen", async () => {
      const scroller = pageWithScroller(1500);
      render(transcript([agentRow(agent("a1", [text(LONG)]))]), { container: scroller });

      press();
      await settle();

      expect(scroller.scrollTop).toBe(1500);
    });

    it("corrects layout that settles late", async () => {
      const scroller = pageWithScroller(400);
      render(transcript([agentRow(agent("a1", [text(LONG)]))]), { container: scroller });

      press();
      // Code highlighting makes the page move the bubble a frame later.
      shift = 12;
      await settle();

      expect(scroller.scrollTop).toBe(412);
    });

    it("asks the transcript to hold its pin to the bottom while it settles", () => {
      const scroller = pageWithScroller(400);
      const held = rs.fn();
      document.addEventListener(HOLD_STICK_EVENT, held);
      render(transcript([agentRow(agent("a1", [text(LONG)]))]), { container: scroller });

      press();
      press();

      document.removeEventListener(HOLD_STICK_EVENT, held);
      expect(held).toHaveBeenCalledTimes(2);
    });
  });

  describe("with Reply", () => {
    it("replies with the whole message from a cut bubble", () => {
      const draft = draftOf();
      render(transcript([agentRow(agent("a1", [text(LONG)]))], draft));
      expect(toggles()[0].getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(screen.getByRole("button", { name: "Reply" }));

      expect(draft.set).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "a1", preview: LONG }),
      );
      expect(draft.set).toHaveBeenCalledWith(
        expect.not.objectContaining({ quote: expect.anything() }),
      );
    });

    it("quotes a selection made in the cut part", () => {
      const draft = draftOf();
      render(transcript([agentRow(agent("a1", [text(LONG)]))], draft));
      const cut = screen.getByText(/^Line 18\.+$/);
      window.getSelection()?.selectAllChildren(cut);

      fireEvent.click(screen.getByRole("button", { name: "Reply" }));

      expect(draft.set).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "a1", quote: cut.textContent }),
      );
    });
  });
});

describe("Concierge forwarded report", () => {
  const forwarded = (extra: Record<string, unknown> = {}) =>
    text(LONG, {
      format: "long",
      forwardedFrom: { chatId: "task-7", title: "Flights to Lisbon" },
      ...extra,
    });
  const bubbles = () => Array.from(document.querySelectorAll<HTMLElement>("div.rounded-16"));
  const chip = () => screen.getByRole("link", { name: "Open task chat Flights to Lisbon" });

  it("is one bubble with a quote's gray left edge, the chip at its top, and the report cut inside", () => {
    render(transcript([agentRow(agent("a1", [forwarded()]))]));

    expect(bubbles()).toHaveLength(1);
    const [bubble] = bubbles();
    expect(bubble.className).toContain("border-l-3");
    expect(bubble.className).toContain("border-l-muted-foreground");
    // No card inside the bubble.
    expect(bubble.querySelector("div.rounded-8.border-l-3")).toBeNull();
    expect(bubble.firstElementChild?.contains(chip())).toBe(true);
    expect(bubble.contains(toggles()[0])).toBe(true);
    expect(bubble.contains(screen.getByText(/^Line 1\.+$/))).toBe(true);
  });

  it("names the task chat in a small chip, and opens it", () => {
    render(transcript([agentRow(agent("a1", [forwarded()]))]));

    expect(chip().textContent).toBe("Flights to Lisbon");
    expect(chip().getAttribute("href")).toBe("/chat/task-7");
    expect(chip().querySelector("svg.lucide-chevron-right")).not.toBeNull();
    // The title is cut with an ellipsis when it does not fit.
    expect(within(chip()).getByText("Flights to Lisbon").className).toContain("truncate");

    fireEvent.click(chip());

    expect(screen.getByTestId("location").textContent).toBe("/chat/task-7");
  });

  it("shows the lead-in as a bubble of its own above the report", () => {
    render(transcript([agentRow(agent("a1", [text("Here it is"), forwarded()]))]));

    expect(bubbles()).toHaveLength(2);
    const [lead, report] = bubbles();
    expect(lead.textContent).toBe("Here it is");
    expect(lead.className).not.toContain("border-l-3");
    expect(lead.contains(chip())).toBe(false);
    expect(report.contains(chip())).toBe(true);
  });

  it("replies to each bubble with its own text", () => {
    const draft = draftOf();
    render(transcript([agentRow(agent("a1", [text("Here it is"), forwarded()]))], draft));
    const [replyToLead, replyToReport] = screen.getAllByRole("button", { name: "Reply" });

    fireEvent.click(replyToLead);
    fireEvent.click(replyToReport);

    expect(draft.set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ messageId: "a1", preview: "Here it is" }),
    );
    expect(draft.set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ messageId: "a1", preview: LONG }),
    );
  });

  it("quotes a selection made in the report, though the lead-in is the message's first bubble", () => {
    const draft = draftOf();
    render(transcript([agentRow(agent("a1", [text("Here it is"), forwarded()]))], draft));
    const line = screen.getByText(/^Line 5\.+$/);
    window.getSelection()?.selectAllChildren(line);

    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[1]);

    expect(draft.set).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "a1", quote: line.textContent }),
    );
  });

  it("is a bubble of its own when there is no lead-in", () => {
    render(transcript([agentRow(agent("a1", [forwarded()]))]));

    expect(bubbles()).toHaveLength(1);
  });

  it("has no chip and no quote edge on a message that was not forwarded", () => {
    render(transcript([agentRow(agent("a1", [text(LONG, { format: "long" })]))]));

    expect(screen.queryByRole("link")).toBeNull();
    expect(bubbles()[0].className).not.toContain("border-l-3");
    // The same cut and the same button as the forwarded report's.
    expect(toggles()).toHaveLength(1);
  });

  it("ignores origin data that is not a chat id and a title", () => {
    render(
      transcript([
        agentRow(
          agent("a1", [forwarded({ forwardedFrom: { chatId: 7 } })]),
          agent("a2", [text(SHORT, { forwardedFrom: "x" })]),
        ),
      ]),
    );

    expect(screen.queryByRole("link")).toBeNull();
  });
});
