import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** How long the divider must stay in view at the bottom before the pill gives up on it. */
const SETTLE_MS = 600;

/**
 * "N new messages" pill that takes the guardian up to the unread divider.
 *
 * It appears once the divider is above the visible transcript, or is not
 * loaded yet, and goes away for good when the guardian taps it or scrolls the
 * divider into view. A divider that stays in view while the transcript rests
 * at the bottom, because the unread messages fit on screen, never shows it. `anchored` says the divider's
 * message is loaded: when the chat draws nothing for it, there is no divider
 * and no pill.
 */
export function ConciergeUnreadPill({
  scroller,
  content,
  count,
  more,
  anchored,
  onJump,
}: {
  scroller: HTMLElement | null;
  /** The transcript element, which holds the divider. */
  content: HTMLElement | null;
  /** The unread messages loaded so far. */
  count: number;
  /** More unread messages wait on an older page, so `count` reads as "N+". */
  more: boolean;
  anchored: boolean;
  onJump: () => void;
}) {
  const { t } = useTranslation("chat");
  const [phase, setPhase] = useState<"waiting" | "shown" | "done">("waiting");

  useEffect(() => {
    if (!scroller || !content || phase === "done") return;
    let frame = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      frame = 0;
      const divider = content.querySelector("[data-concierge-unread-divider]");
      // A message under the chat's floating header is out of sight too.
      const clear = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
      const above = divider
        ? divider.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().top + clear
        : !anchored;
      if (above) {
        clearTimeout(settle);
        settle = undefined;
        setPhase((current) => (current === "done" ? current : "shown"));
        return;
      }
      setPhase((current) => (current === "shown" ? "done" : current));
      // The transcript loads at its top, scrolls to the bottom, and then grows
      // as cards and images load, which can push the divider up out of view.
      // So a divider in view counts as seen only when it stays in view at the
      // bottom for {@link SETTLE_MS}. Seen that way, the unread messages fit on
      // screen, and later arrivals pushing the divider up must not bring the pill.
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;
      if (!atBottom) {
        clearTimeout(settle);
        settle = undefined;
      } else if (settle === undefined) {
        settle = setTimeout(() => setPhase((c) => (c === "waiting" ? "done" : c)), SETTLE_MS);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(scroller);
    resize.observe(content);
    const mutations = new MutationObserver(schedule);
    mutations.observe(content, { subtree: true, childList: true });
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      resize.disconnect();
      mutations.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, [scroller, content, anchored, phase]);

  if (phase !== "shown") return null;
  const label = more ? `${count}+` : String(count);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        setPhase("done");
        onJump();
      }}
      className="touch-target pointer-events-auto rounded-full bg-surface/95 shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80"
    >
      <ArrowUp data-icon="inline-start" />
      {t("concierge.newMessagesPill", { count, label })}
    </Button>
  );
}
