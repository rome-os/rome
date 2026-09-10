import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
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

const EMPTY: TimelineNode[] = [];

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

    /** Lays the question markers out. */
    const measure = () => {
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
        return;
      }
      const next = layoutTimelineNodes(
        questions.map((question) => question.messageId),
        {
          trackHeight: track.clientHeight,
          stepPx: TIMELINE_NODE_STEP_PX,
        },
      );
      setNodes((prev) => (sameNodes(prev, next) ? prev : next));
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, MEASURE_DEBOUNCE_MS);
    };

    measure();

    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    if (content && content !== scroller) observer.observe(content);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [scroller, content, questions]);

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
      <div ref={trackRef} data-timeline-track className="absolute top-16 bottom-32 left-0 w-8">
        <div data-timeline-markers className="absolute inset-0">
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
                    tabbable. */}
                      <button
                        type="button"
                        ref={(el) => {
                          nodeRefs.current[index] = el;
                        }}
                        tabIndex={index !== activeNode ? -1 : 0}
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
