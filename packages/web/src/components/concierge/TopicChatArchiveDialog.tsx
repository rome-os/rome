import type { ConciergeChatWorkResponse } from "@rome/api-types/concierge";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { fetchConciergeChatWork } from "@/hooks/use-concierge";
import {
  DELETE_CHOICE_KEYS,
  TopicChatWorkChoice,
  useTopicChatWorkItems,
} from "./TopicChatDeleteDialog";

/**
 * How long archiving or unarchiving waits for the list of what it would move
 * before it goes ahead as it always has: an older instance, or a slow network.
 */
export const TOPIC_CHAT_WORK_WAIT_MS = 3_000;

/** What the open dialog asks about, read before it opens so it never changes while up. */
type Asking =
  | { kind: "archive"; work: ConciergeChatWorkResponse }
  | { kind: "unarchive"; follows: NonNullable<ConciergeChatWorkResponse["movedFollows"]> };

const UNARCHIVE_CHOICE_KEYS = {
  moveBack: {
    label: "recentChats.topicChatUnarchiveMoveBack",
    hint: "recentChats.topicChatUnarchiveMoveBackHint",
  },
  keep: {
    label: "recentChats.topicChatUnarchiveKeep",
    hint: "recentChats.topicChatUnarchiveKeepHint",
  },
} as const;

/**
 * Archiving and unarchiving topic chat `chatId`, asking first when there is
 * something to choose for, as its delete does. Archiving a chat with follows
 * or open tasks asks whether they move to the main chat (the default) or
 * stop. Unarchiving one whose archive moved follows that are still in the
 * main chat asks whether they move back (the default) or stay. With nothing
 * to ask, or when the list cannot be read in time, it goes ahead as before:
 * an archive moves everything, an unarchive moves nothing back.
 *
 * `onArchive` and `onUnarchive` do the change; `dialog` is to be rendered.
 * When `topic` is false (not a topic chat) both go ahead without asking.
 */
export function useTopicChatArchive({
  chatId,
  name,
  topic,
  onArchive,
  onUnarchive,
}: {
  chatId: string | null;
  /** The chat's name as the person sees it. */
  name: string;
  topic: boolean;
  onArchive: (stopWork: boolean) => void;
  onUnarchive: (moveFollowsBack: boolean) => void;
}): { archive: () => Promise<void>; unarchive: () => Promise<void>; dialog: ReactNode } {
  const [asking, setAsking] = useState<Asking | null>(null);
  // Closing keeps what it asked, so the dialog does not change as it closes.
  const [open, setOpen] = useState(false);
  const ask = (next: Asking) => {
    setAsking(next);
    setOpen(true);
  };
  // A second click while the list is read starts no other read.
  const reading = useRef(false);
  const read = useCallback(async () => {
    if (!chatId || !topic) return null;
    return fetchConciergeChatWork(chatId, AbortSignal.timeout(TOPIC_CHAT_WORK_WAIT_MS)).catch(
      () => null,
    );
  }, [chatId, topic]);
  const archive = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const work = await read();
    reading.current = false;
    if (work && (work.follows.length > 0 || work.openTasks.length > 0)) {
      ask({ kind: "archive", work });
    } else onArchive(false);
  }, [read, onArchive]);
  const unarchive = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const follows = (await read())?.movedFollows ?? [];
    reading.current = false;
    if (follows.length > 0) ask({ kind: "unarchive", follows });
    else onUnarchive(false);
  }, [read, onUnarchive]);
  const dialog = chatId ? (
    <TopicChatArchiveDialog
      chatId={chatId}
      name={name}
      asking={asking}
      open={open}
      onCancel={() => setOpen(false)}
      onArchive={(stopWork) => {
        setOpen(false);
        onArchive(stopWork);
      }}
      onUnarchive={(moveBack) => {
        setOpen(false);
        onUnarchive(moveBack);
      }}
    />
  ) : null;
  return { archive, unarchive, dialog };
}

function TopicChatArchiveDialog({
  chatId,
  name,
  asking,
  open,
  onCancel,
  onArchive,
  onUnarchive,
}: {
  chatId: string;
  name: string;
  asking: Asking | null;
  open: boolean;
  onCancel: () => void;
  onArchive: (stopWork: boolean) => void;
  onUnarchive: (moveBack: boolean) => void;
}) {
  const { t } = useTranslation("common");
  const [work, setWork] = useState<"move" | "stop">("move");
  const [follows, setFollows] = useState<"moveBack" | "keep">("moveBack");
  const archiving = asking?.kind === "archive";
  const items = useTopicChatWorkItems(
    archiving ? asking.work.follows : asking?.kind === "unarchive" ? asking.follows : [],
    archiving ? asking.work.openTasks : [],
  );
  const reset = () => {
    setWork("move");
    setFollows("moveBack");
  };
  return (
    <RomeConfirmDialog
      open={open && asking !== null}
      title={t(
        archiving ? "recentChats.topicChatArchiveTitle" : "recentChats.topicChatUnarchiveTitle",
        { name },
      )}
      description={t(
        archiving ? "recentChats.topicChatArchiveWithWork" : "recentChats.topicChatUnarchiveMoved",
      )}
      confirmLabel={t(archiving ? "recentChats.archive" : "recentChats.unarchive")}
      onCancel={() => {
        reset();
        onCancel();
      }}
      onConfirm={() => {
        reset();
        if (archiving) onArchive(work === "stop");
        else onUnarchive(follows === "moveBack");
      }}
    >
      {archiving ? (
        <TopicChatWorkChoice
          id={`topic-archive-${chatId}`}
          items={items}
          question={t("recentChats.topicChatDeleteChoice")}
          value={work}
          onChange={(next) => setWork(next === "stop" ? "stop" : "move")}
          choices={(["move", "stop"] as const).map((value) => ({
            value,
            label: t(DELETE_CHOICE_KEYS[value].label),
            hint: t(DELETE_CHOICE_KEYS[value].hint),
          }))}
        />
      ) : asking ? (
        <TopicChatWorkChoice
          id={`topic-unarchive-${chatId}`}
          items={items}
          question={t("recentChats.topicChatDeleteChoice")}
          value={follows}
          onChange={(next) => setFollows(next === "keep" ? "keep" : "moveBack")}
          choices={(["moveBack", "keep"] as const).map((value) => ({
            value,
            label: t(UNARCHIVE_CHOICE_KEYS[value].label),
            hint: t(UNARCHIVE_CHOICE_KEYS[value].hint),
          }))}
        />
      ) : null}
    </RomeConfirmDialog>
  );
}
