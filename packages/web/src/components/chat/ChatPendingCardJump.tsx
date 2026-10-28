import { useEffect, useState } from "react";
import { SquareMousePointer } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export function ChatPendingCardJump({
  scroller,
  content,
  floor,
  currentReplyMessageIds,
}: {
  scroller: HTMLElement | null;
  content: HTMLElement | null;
  floor: HTMLElement | null;
  currentReplyMessageIds: ReadonlySet<string>;
}) {
  const { t } = useTranslation("chat");
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!scroller || !content || !floor) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const viewport = scroller.getBoundingClientRect();
      // The sticky composer covers part of the scroller, even though cards
      // behind it still intersect the scroller's bounding box.
      const bottom = Math.min(viewport.bottom, floor.getBoundingClientRect().top);
      // Cards mark their live state: transcript JSON cannot tell a draft from
      // a routine that was already turned on, or an approval resolved elsewhere.
      const cards = content.querySelectorAll<HTMLElement>("[data-chat-pending-card]");
      // Only an approval waits across turns, since the server holds it until it
      // is resolved. Any other card stops counting once a newer turn starts.
      const next = Array.from(cards).find((card) => {
        if (card.dataset.chatPendingCard !== "approval") {
          const messageId = card.closest<HTMLElement>("[data-chat-card-message]")?.dataset
            .chatCardMessage;
          if (!messageId || !currentReplyMessageIds.has(messageId)) return false;
        }
        const rect = card.getBoundingClientRect();
        return rect.height > 0 && (rect.bottom <= viewport.top || rect.top >= bottom);
      });
      setTarget(next ?? null);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(scroller);
    resize.observe(content);
    resize.observe(floor);
    const mutations = new MutationObserver(schedule);
    mutations.observe(content, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-chat-pending-card", "data-chat-card-message"],
    });
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, [scroller, content, floor, currentReplyMessageIds]);

  if (!target || !scroller || !content?.contains(target)) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={t("jumpToWaitingCard")}
      onClick={() => {
        target.focus({ preventScroll: true });
        scroller.scrollTo({
          top:
            scroller.scrollTop +
            target.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top,
          behavior: "instant",
        });
      }}
      className="touch-target pointer-events-auto rounded-full bg-surface/95 shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80"
    >
      {/* Below 21rem the label alone keeps the button clear of jump to latest. */}
      <SquareMousePointer data-icon="inline-start" className="max-[21rem]:hidden" />
      {t("waitingCard")}
    </Button>
  );
}
