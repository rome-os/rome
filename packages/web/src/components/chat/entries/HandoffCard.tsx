import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { prettyAgentName } from "@/lib/agent-name";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import ChatMarkdown from "@/components/chat/ChatMarkdown";

// open: caller suspended, specialist holds the floor. completed: handed a plan
// back and the caller resumed. cancelled: the design was dismissed without a
// handback (surface closed / Cancel), so the caller resumed empty-handed — the
// only status that adds a label.
export type HandoffStatus = "open" | "completed" | "cancelled";

export interface HandoffCardProps {
  appId: string;
  agentName?: string;
  agentLabel?: string;
  // The brief the calling agent handed off — shown as its @mention content.
  summary?: string;
  status: HandoffStatus;
}

// A brief taller than this collapses behind a "Show all" toggle. Measured in
// rendered line-heights, not characters, so it tracks whatever the brief renders
// to (paragraphs, lists, code) rather than guessing at wrap width.
const CLAMP_LINES = 6;

// The @mention seam: the calling agent mentioning a specialist, styled like a
// group-chat @-mention chip (primary tint throughout). The specialist's turns
// render as ordinary rows right below — there is no separate thread. (Cancelling
// an open handoff lives in the composer, where the floor is.) The chip is a
// header line; the brief renders as markdown beneath it (clamped to CLAMP_LINES).
export function HandoffCard({ appId, agentName, agentLabel, summary, status }: HandoffCardProps) {
  const label = agentLabel || prettyAgentName(agentName ?? appId);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // maxHeight is the clamp ceiling (CLAMP_LINES line-heights); overflowing is
  // whether the full brief exceeds it. Both re-measured on width/content change.
  const [clamp, setClamp] = useState<{ maxHeight: number; overflowing: boolean } | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // Measure the markdown root's own line-height rather than assuming the
      // wrapper's value, so CLAMP_LINES tracks the rendered brief exactly.
      const inner = (el.firstElementChild as HTMLElement | null) ?? el;
      const lineHeight = parseFloat(getComputedStyle(inner).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
      const maxHeight = lineHeight * CLAMP_LINES;
      // scrollHeight is the full content height even while the clamp is applied,
      // so the measurement is stable across the collapsed/expanded toggle.
      setClamp({ maxHeight, overflowing: el.scrollHeight > maxHeight + 1 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [summary]);

  const collapsed = !!clamp?.overflowing && !expanded;

  return (
    <div className="mb-2 rounded-12 border-l-2 border-primary bg-primary/5 px-3 py-2 text-ui text-foreground">
      <span className="inline-flex items-center gap-1 rounded-8 bg-primary/15 px-2 py-1 text-badge text-primary">
        @
        <AgentAvatar
          iconUrl={`/api/apps/${encodeURIComponent(appId)}/icon`}
          label={label}
          className="size-4 shrink-0"
        />
        {label}
      </span>
      {summary ? (
        <>
          <div
            ref={bodyRef}
            className="mt-2"
            // Clamp to CLAMP_LINES line-heights while collapsed; full height once
            // expanded. Inline because the ceiling is measured, not a fixed token.
            style={
              collapsed && clamp ? { maxHeight: clamp.maxHeight, overflow: "hidden" } : undefined
            }
          >
            {/* The brief is agent-authored and may carry markdown (bold, lists,
                links) — render it like every other chat message, not raw text. */}
            <ChatMarkdown className="text-foreground" compact>
              {summary}
            </ChatMarkdown>
          </div>
          {clamp?.overflowing ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 inline-flex items-center gap-1 text-aux text-primary hover:underline"
            >
              {expanded ? (
                <>
                  Show less <ChevronUp className="size-3" />
                </>
              ) : (
                <>
                  Show all <ChevronDown className="size-3" />
                </>
              )}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
