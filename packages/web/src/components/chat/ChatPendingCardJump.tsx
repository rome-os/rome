import { useEffect, useMemo, useState } from "react";
import type { TaskCard } from "@rome/api-types/chat";
import { useConciergeTasks } from "@/components/concierge/use-concierge-tasks";
import type { ChatMessage } from "@/lib/chat-types";
import { waitingTaskCardMessages } from "./waiting-task-cards";
import { SquareMousePointer } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { findMessageAnchor } from "@/components/chat/reply/reply-source";

const NO_MESSAGES: ReadonlySet<string> = new Set();

export function ChatPendingCardJump({
  scroller,
  content,
  floor,
  currentReplyMessageIds,
  waitingTaskMessageIds = NO_MESSAGES,
}: {
  scroller: HTMLElement | null;
  content: HTMLElement | null;
  floor: HTMLElement | null;
  currentReplyMessageIds: ReadonlySet<string>;
  /**
   * The messages whose task card holds what its task waits on its owner for,
   * from the server's facts (waiting-task-cards.ts). The jump counts these,
   * not what a task card happens to have drawn.
   */
  waitingTaskMessageIds?: ReadonlySet<string>;
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
      // A task's waiting card is the one the server says the task waits on:
      // its message's card when drawn, else the message itself.
      const tasks = [...waitingTaskMessageIds].flatMap((messageId) => {
        const anchor = findMessageAnchor(content, messageId);
        if (!anchor) return [];
        return [anchor.querySelector<HTMLElement>("[data-chat-pending-card]") ?? anchor];
      });
      const cards = Array.from(
        content.querySelectorAll<HTMLElement>("[data-chat-pending-card]"),
      ).filter((card) => !card.closest("[data-chat-task-waiting]"));
      // Approvals and waiting task cards outlive the main Chat's current reply.
      // Other cards stop counting once a newer turn starts.
      const next = [...cards, ...tasks]
        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        .find((card) => {
          if (card.dataset.chatPendingCard !== "approval" && !tasks.includes(card)) {
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
      attributeFilter: [
        "data-chat-pending-card",
        "data-chat-card-message",
        "data-chat-task-waiting",
        "data-timeline-anchor",
      ],
    });
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, [scroller, content, floor, currentReplyMessageIds, waitingTaskMessageIds]);

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

/**
 * The jump in a Concierge chat: its task cards count by what the server says
 * each task waits on its owner for, whether or not a card has drawn yet.
 */
export function ConciergeCardJump({
  messages,
  liveCards,
  ...jump
}: Omit<Parameters<typeof ChatPendingCardJump>[0], "waitingTaskMessageIds"> & {
  messages: readonly ChatMessage[];
  /** Cards live events settled since the messages loaded. */
  liveCards: ReadonlyMap<string, TaskCard>;
}) {
  const { tasks } = useConciergeTasks({ allDone: true });
  const waiting = useMemo(
    () => waitingTaskCardMessages(messages, tasks, liveCards),
    [messages, tasks, liveCards],
  );
  return <ChatPendingCardJump {...jump} waitingTaskMessageIds={waiting} />;
}
