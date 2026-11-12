import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CONCIERGE_UNREAD_CAP } from "@/hooks/use-concierge";

/**
 * "N new messages" pill that takes the guardian up to the unread divider.
 *
 * It appears once the divider is above the visible transcript, or is not
 * loaded yet, and goes away for good when the guardian taps it or scrolls the
 * divider into view. A divider in view when the transcript rests at the
 * bottom, because the unread messages fit on screen, never shows it. `anchored` says the divider's
 * message is loaded: when the chat draws nothing for it, there is no divider
 * and no pill.
 */
export function ConciergeUnreadPill({
  scroller,
  content,
  count,
  anchored,
  onJump,
}: {
  scroller: HTMLElement | null;
  /** The transcript element, which holds the divider. */
  content: HTMLElement | null;
  count: number;
  anchored: boolean;
  onJump: () => void;
}) {
  const { t } = useTranslation("chat");
  const [phase, setPhase] = useState<"waiting" | "shown" | "done">("waiting");

  useEffect(() => {
    if (!scroller || !content || phase === "done") return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const divider = content.querySelector("[data-concierge-unread-divider]");
      // A message under the chat's floating header is out of sight too.
      const clear = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
      const above = divider
        ? divider.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().top + clear
        : !anchored;
      // The transcript loads at its top and then scrolls to the bottom, so a
      // divider in view only counts as seen once the transcript is at the
      // bottom. Seen from there, the unread messages fit on screen, and
      // later arrivals pushing the divider up must not bring the pill.
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;
      setPhase((current) => {
        if (current === "done") return current;
        if (above) return "shown";
        return current === "shown" || atBottom ? "done" : current;
      });
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
      resize.disconnect();
      mutations.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, [scroller, content, anchored, phase]);

  if (phase !== "shown") return null;
  const label = count >= CONCIERGE_UNREAD_CAP ? "99+" : String(count);
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
