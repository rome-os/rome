import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  layoutTimelineNodes,
  sameNodes,
  shouldShowTimeline,
  summarizeQuestion,
  TIMELINE_NODE_STEP_PX,
  type TimelineNode,
  type TimelineQuestion,
} from "@/components/chat/chat-timeline";

// Re-checking is trailing-debounced because a streamed reply can resize the
// content on every token before the transcript crosses the visibility gate.
const MEASURE_DEBOUNCE_MS = 150;
const CONTROL_NODE_GAP_PX = 24;

const EMPTY: TimelineNode[] = [];

// Matches how the sidebar remembers its own collapse (RomeShellLayout).
const HIDDEN_KEY = "rome-timeline-hidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export interface ChatTimelineRailProps {
  /** The chat's single scrolling node. */
  scroller: HTMLElement | null;
  /**
   * The growing content wrapper inside the scroller. Observed separately
   * because content height changes do not resize the scroller itself, so a
   * ResizeObserver on the scroller alone would not notice when the transcript
   * becomes long enough to need navigation.
   */
  content: HTMLElement | null;
  questions: TimelineQuestion[];
  onJump: (messageId: string) => void;
}

/**
 * A compact column of bars in the left gutter of the transcript — one per past
 * user question. Hovering names the question, clicking jumps to it.
 *
 * Deliberately the quietest thing on screen: short bars at 40% opacity and no
 * connecting line. Their fixed rhythm represents question order, not rendered
 * message height, so wrapping and streamed replies cannot reshape the index.
 */
export function ChatTimelineRail({ scroller, content, questions, onJump }: ChatTimelineRailProps) {
  const { t } = useTranslation("chat");
  const [nodes, setNodes] = useState<TimelineNode[]>(EMPTY);
  const [hidden, setHidden] = useState(readHidden);
  // The bars are positioned in this element's pixel coordinate space. Measuring
  // the track directly lets the compact step tighten only when the column is
  // truly saturated.
  const trackRef = useRef<HTMLDivElement | null>(null);
  // The column is one composite control, not forty. Only the roving bar is in
  // the tab order; arrows move between bars from there. Tabbing every bar would
  // bury the rest of the page behind dozens of stops in exactly the long chats
  // this exists for, and dropping them from the tab order altogether would
  // leave the transcript with no keyboard route back to an earlier question.
  const [rovingIndex, setRovingIndex] = useState(0);
  const nodeRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!scroller) {
      setNodes((prev) => (prev.length === 0 ? prev : EMPTY));
      return;
    }
    let timer = 0;

    /** Lays the question markers out, and reports whether there are any. */
    const measure = (): boolean => {
      const track = trackRef.current;
      // A zero-height track means the rail is CSS-hidden below its breakpoint,
      // where the sweep below can only ever produce nothing. Checking it first
      // keeps a narrow viewport from paying for a forced layout on every
      // debounce tick of a streaming reply.
      if (
        !track ||
        track.clientHeight === 0 ||
        !shouldShowTimeline(questions.length, {
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
        })
      ) {
        setNodes((prev) => (prev.length === 0 ? prev : EMPTY));
        return false;
      }
      const next = layoutTimelineNodes(
        questions.map((question) => question.messageId),
        {
          trackHeight: track.clientHeight,
          stepPx: TIMELINE_NODE_STEP_PX,
        },
      );
      setNodes((prev) => (sameNodes(prev, next) ? prev : next));
      return next.length > 0;
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, MEASURE_DEBOUNCE_MS);
    };

    // Always measure once, even while hidden: the node count is what decides
    // whether the show control renders at all, and skipping this would strand a
    // reader who hid the rail and then reloaded with no way to bring it back.
    const anyNodes = measure();
    // With markers to keep, a hidden column has nothing left to stay in sync with,
    // and a streaming reply would otherwise drive a layout flush plus a
    // re-render every debounce tick for something not on screen. Unhiding
    // re-runs this effect, so the markers are measured fresh when they return.
    //
    // With NO markers the observer has to stay: the rail may still become eligible
    // — a wider viewport, a transcript that grows past two screens — and the
    // show control has to appear when it does rather than waiting for the next
    // message or a reload.
    if (hidden && anyNodes) return () => window.clearTimeout(timer);

    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    if (content && content !== scroller) observer.observe(content);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [scroller, content, questions, hidden]);

  // Clamped rather than reset: questions arrive while the chat runs, and the
  // caret should not jump back to the top each time one does.
  const activeNode = Math.min(rovingIndex, Math.max(nodes.length - 1, 0));

  const onNodeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = nodes.length - 1;
      let next: number;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = Math.min(index + 1, last);
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = Math.max(index - 1, 0);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = last;
      else return;
      event.preventDefault();
      setRovingIndex(next);
      nodeRefs.current[next]?.focus();
    },
    [nodes.length],
  );

  const toggleHidden = useCallback(() => {
    setHidden((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(HIDDEN_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  // The track stays mounted even with nothing to show. `measure` reads its
  // height, so an early return here would leave `trackRef` null, which would
  // make the measurement bail, which would keep `nodes` empty — the rail would
  // never appear at all. Only the contents are conditional.
  const empty = nodes.length === 0;

  return (
    // A marker's centre sits in the middle of the 32px left lane. The transcript is
    // `mx-auto max-w-5xl`, so once the container drops under 1024px the body
    // fills it and a bubble's edge runs straight into the markers. Chat gives
    // the scroller a matching left inset under the SAME query, which opens a
    // permanent lane for the rail — so this gate is only about whether the
    // surface is big enough to be worth navigating, not about whether the markers
    // fit. Keep the two queries in sync: Chat.tsx's `pl-8` is what makes any
    // width below 1024 safe.
    //
    // The container is `transcript`, declared on Chat's scroller wrapper — NOT
    // `chat`, which is declared on an outer element that never narrows when the
    // trace drawer takes its 480px.
    //
    // Pointer events stay off the whole strip and are re-enabled only on the
    // markers, so the native scrollbar and the composer's right edge remain
    // grabbable underneath.
    <div
      // No landmark until there is a timeline inside it. Short chats are the
      // common case, and an empty named region is something a screen-reader
      // user lands in and finds nothing.
      role={empty ? undefined : "navigation"}
      aria-label={empty ? undefined : t("timeline.label")}
      className="group pointer-events-none absolute inset-y-0 left-0 z-10 hidden w-8 @min-[48rem]/transcript:block"
    >
      {/* The control and markers share one coordinate space, so the eye follows
          the compact group instead of staying stranded at the top of the rail. */}
      <div ref={trackRef} data-timeline-track className="absolute top-16 bottom-32 left-0 w-8">
        {empty ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleHidden}
                aria-label={hidden ? t("timeline.show") : t("timeline.hide")}
                aria-expanded={!hidden}
                style={{ top: nodes[0].topPx - CONTROL_NODE_GAP_PX }}
                className="pointer-events-auto absolute left-4 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground opacity-30 transition-opacity duration-200 ease-out group-hover:opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring motion-reduce:transition-none"
              >
                {hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {hidden ? t("timeline.show") : t("timeline.hide")}
            </TooltipContent>
          </Tooltip>
        )}
        {/* Hiding slides the markers out to the left and fades them, rather than
            unmounting them, so the effect runs in both directions. `visibility`
            carries the safety: it flips discretely at the END of the transition,
            so the markers stop taking pointer events when they are gone.
            `aria-hidden` removes them from the accessibility tree at the same
            time, while the eye remains available to restore them. */}
        <div
          data-timeline-markers
          aria-hidden={hidden}
          className={`absolute inset-0 transition-[opacity,translate,visibility] duration-200 ease-out motion-reduce:transition-none ${
            hidden ? "invisible -translate-x-6 opacity-0" : "visible translate-x-0 opacity-100"
          }`}
        >
          {empty
            ? null
            : nodes.map((node, index) => {
                const question = questions.find((q) => q.messageId === node.messageId);
                if (!question) return null;
                const label = summarizeQuestion(question.text);
                return (
                  <Tooltip key={node.messageId}>
                    <TooltipTrigger asChild>
                      {/* A bare <button>, never the ui-kit Button: the /chat layout
                    invariant sweep measures every [data-slot="button"] for
                    vertical centring and sibling-uniform heights, which a
                    free-positioned marker fails by construction. The label is the
                    question alone — Radix already wires the tooltip as
                    aria-describedby, so a "jump to" prefix would make a screen
                    reader add a prefix to a question it announces twice
                    regardless: Radix wires the tooltip as the description while
                    this is the name, so both carry the question. Naming the
                    action instead would not remove the repetition, only pad it.

                    Focus is styled like hover, so the bar under the caret
                    reads like the one under the cursor. Only the roving marker is
                    tabbable; hidden markers leave the tab order entirely, so
                    nothing focusable ever sits inside `aria-hidden`. */}
                      <button
                        type="button"
                        ref={(el) => {
                          nodeRefs.current[index] = el;
                        }}
                        tabIndex={hidden || index !== activeNode ? -1 : 0}
                        aria-label={label}
                        onKeyDown={(event) => onNodeKeyDown(event, index)}
                        onFocus={() => setRovingIndex(index)}
                        onClick={() => onJump(node.messageId)}
                        style={{ top: node.topPx }}
                        className="pointer-events-auto absolute left-4 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full before:absolute before:top-1/2 before:left-1 before:h-0.5 before:w-2 before:-translate-y-1/2 before:origin-left before:rounded-full before:scale-x-100 before:bg-muted-foreground before:opacity-40 before:transition-[opacity,scale] before:duration-200 before:ease-out motion-reduce:before:transition-none group-hover:before:opacity-70 hover:before:scale-x-150 hover:before:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring focus-visible:before:scale-x-150 focus-visible:before:opacity-100"
                      />
                    </TooltipTrigger>
                    {/* The offset clears the marker: TooltipContent's arrow is 10px
                  rotated 45°, which at the default offset of 0 would land on
                  top of the bar. */}
                    <TooltipContent side="right" sideOffset={8}>
                      {label}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
        </div>
      </div>
    </div>
  );
}
