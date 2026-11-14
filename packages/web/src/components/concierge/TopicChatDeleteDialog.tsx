import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useConciergeChatWork, useConciergeName } from "@/hooks/use-concierge";

/** How many follows and tasks the delete dialog lists before "and N more". */
const DELETE_DIALOG_ITEMS = 5;

/** The delete dialog's two choices for a topic chat's follows and open tasks. */
const DELETE_CHOICE_KEYS = {
  move: {
    label: "recentChats.topicChatDeleteMove",
    hint: "recentChats.topicChatDeleteMoveHint",
  },
  stop: {
    label: "recentChats.topicChatDeleteStop",
    hint: "recentChats.topicChatDeleteStopHint",
  },
} as const;

/**
 * Confirms deleting topic chat `chatId`. It lists the chat's follows and open
 * tasks and asks whether they move to the main chat (the default) or stop.
 * `onConfirm` gets `stopWork` true only when there are some and the person
 * chose to stop them. The sidebar's and the chat header's delete both use it.
 */
export function TopicChatDeleteDialog({
  open,
  chatId,
  name,
  archived,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  chatId: string;
  /** The chat's name as the person sees it. */
  name: string;
  archived: boolean;
  onCancel: () => void;
  onConfirm: (stopWork: boolean) => void;
}) {
  const { t } = useTranslation("common");
  const conciergeName = useConciergeName();
  // What happens to the chat's follows and open tasks when it is deleted.
  const [work, setWork] = useState<"move" | "stop">("move");
  // An archived chat's follows and tasks moved when it was archived.
  const chatWork = useConciergeChatWork(chatId, open && !archived);
  const items = [
    ...(chatWork.data?.follows ?? []).map((follow) => ({
      key: `follow:${follow.source}:${follow.target}`,
      text: t("recentChats.topicChatDeleteFollow", { source: follow.label, target: follow.target }),
    })),
    ...(chatWork.data?.openTasks ?? []).map((task) => ({
      key: `task:${task.id}`,
      text: t("recentChats.topicChatDeleteTask", { title: task.title }),
    })),
  ];
  return (
    <RomeConfirmDialog
      open={open}
      destructive
      title={t("recentChats.topicChatDeleteTitle", { name })}
      // While the list loads, or when it cannot, the chat's follows and open
      // tasks are assumed and move, as they do without a choice.
      description={
        chatWork.data
          ? t(
              items.length > 0
                ? "recentChats.topicChatDeleteWithWork"
                : "recentChats.topicChatDeleteEmpty",
            )
          : t("recentChats.topicChatDeleteMoves", { name: conciergeName })
      }
      confirmLabel={t("recentChats.delete")}
      onCancel={() => {
        setWork("move");
        onCancel();
      }}
      onConfirm={() => {
        setWork("move");
        onConfirm(items.length > 0 && work === "stop");
      }}
    >
      {items.length > 0 ? (
        <div className="grid gap-4">
          {/* Long titles keep to two lines, and the list scrolls on a short
              screen, so the choice and the buttons stay in view. */}
          <ul className="grid max-h-[30dvh] gap-1 overflow-y-auto text-ui text-foreground">
            {items.slice(0, DELETE_DIALOG_ITEMS).map((item) => (
              <li key={item.key} className="flex gap-2">
                <span aria-hidden>•</span>
                <span className="line-clamp-2 min-w-0 wrap-anywhere">{item.text}</span>
              </li>
            ))}
            {items.length > DELETE_DIALOG_ITEMS ? (
              <li className="text-muted-foreground">
                {t("recentChats.topicChatDeleteMore", {
                  count: items.length - DELETE_DIALOG_ITEMS,
                })}
              </li>
            ) : null}
          </ul>
          <div className="grid gap-2">
            <p id={`topic-delete-work-${chatId}`} className="text-ui text-foreground">
              {t("recentChats.topicChatDeleteChoice")}
            </p>
            <RadioGroup
              aria-labelledby={`topic-delete-work-${chatId}`}
              value={work}
              onValueChange={(next) => setWork(next === "stop" ? "stop" : "move")}
            >
              {(["move", "stop"] as const).map((value) => (
                <label
                  key={value}
                  htmlFor={`topic-delete-${value}-${chatId}`}
                  className="flex items-start gap-3 text-ui text-foreground"
                >
                  <span className="flex h-5 items-center">
                    <RadioGroupItem id={`topic-delete-${value}-${chatId}`} value={value} />
                  </span>
                  <span className="min-w-0">
                    <span className="block">{t(DELETE_CHOICE_KEYS[value].label)}</span>
                    <span className="block text-aux text-muted-foreground">
                      {t(DELETE_CHOICE_KEYS[value].hint)}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
        </div>
      ) : null}
    </RomeConfirmDialog>
  );
}
