import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { isRenderable } from "@/components/chat/concierge-groups";
import type { ChatMessage } from "@/lib/chat-types";

/** What a Concierge chat held, and where its read mark stood, when it opened. */
export interface UnreadAtOpen {
  /** The chat's read mark before the open marked it read: an ISO time, whole seconds. */
  watermark: string;
  /**
   * The ids of the messages that can be unread: those the chat opened with, and
   * those that came from older pages since. A message that arrives live is never
   * among them. Time cannot tell the two apart, because a page holds whole
   * turns and a turn that began on an older page can reply after the opening
   * page began.
   */
  memberIds: ReadonlySet<string>;
}

/** The unread agent messages of a chat, as far as its loaded history shows them. */
export interface UnreadSummary {
  /** The first unread message the chat draws, or null while it is on an older page or there is none. */
  firstId: string | null;
  /** How many unread agent messages the chat draws among the loaded ones. */
  count: number;
  /** Whether more unread messages wait on an older page, so `count` is a lower bound. */
  more: boolean;
}

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** Whether the Concierge draws `message` as a bubble: it says something and is no model-switch notice. */
function drawsBubble(message: ChatMessage): boolean {
  return (
    isRenderable(message) &&
    !parseMessageEntries(message).some((part) => part.type === "quota_switch")
  );
}

/**
 * The unread agent messages of `messages` at `open`. The server's rule is the
 * same: a message is unread when it was created after the read mark, and both
 * times have one-second precision, so a message in the same second as the mark
 * is read. Each message is judged on its own, because the transcript's order
 * groups messages by turn and is not time order, and only the messages in
 * `open.memberIds` count. `hasOlder` says older pages are not all loaded.
 * Returns null when no loaded message is unread.
 *
 * A page holds whole turns, so a turn on an older page can reply after the
 * mark whatever the loaded turns hold. The first unread message is therefore
 * known only once no older page remains, or once the oldest loaded turn has no
 * unread message, which ends the unread run. A turn that began before every
 * loaded one and replies after the mark is not looked for.
 */
export function summarizeUnread(
  messages: ChatMessage[],
  open: UnreadAtOpen,
  hasOlder: boolean,
): UnreadSummary | null {
  const mark = seconds(open.watermark);
  if (Number.isNaN(mark) || messages.length === 0) return null;
  const isUnread = (message: ChatMessage) => seconds(message.createdAt) > mark;
  const agent = messages.filter(
    (message) => message.role === "assistant" && open.memberIds.has(message.id),
  );
  const drawn = agent.filter((message) => isUnread(message) && drawsBubble(message));
  if (drawn.length === 0) return null;
  const oldestTurn = messages[0].turnId ?? messages[0].id;
  const more =
    hasOlder &&
    agent.some((message) => (message.turnId ?? message.id) === oldestTurn && isUnread(message));
  return { firstId: more ? null : drawn[0].id, count: drawn.length, more };
}

/** The longest the read mark waits for the chat's own read mark before the chat is marked read anyway. */
const MARK_WAIT_MS = 2000;

/**
 * Remembers what a Concierge chat had unread when it opened. `loadReadMark`
 * asks for the chat's read mark. It runs once, when the chat mounts, and its
 * absence means the chat does no pre-read work. A chat opened without an id
 * is a draft that a first send turns into a chat, and has nothing unread.
 *
 * Two things fix `unread`, even once the chat is marked read: the read mark,
 * and which messages can be unread. Those are the messages the chat opened
 * with, which `noteOpened` reports, and the ones older pages bring, which
 * `noteOlder` reports, minus any that `noteLive` saw arrive live, since an older
 * page can hold a live reply to one of its turns. Messages that arrive live are
 * never unread.
 */
export function useUnreadAtOpen({
  chatId,
  loadReadMark,
}: {
  chatId: string | null | undefined;
  /** Resolves with `chatId`'s read mark, or null when it has none. Never rejects. */
  loadReadMark?: (chatId: string) => Promise<string | null>;
}): {
  unread: UnreadAtOpen | null;
  /** Reports the history the chat opened with, once. The first report is the one that counts. */
  noteOpened: (messages: ChatMessage[]) => void;
  /** Reports the messages of an older page that loaded. */
  noteOlder: (messages: ChatMessage[]) => void;
  /** Reports a message that arrived live. It never becomes unread. */
  noteLive: (messageId: string) => void;
  /**
   * Resolves once the read mark is known, or after {@link MARK_WAIT_MS}. Null
   * when none is on the way. Await it before marking the chat read.
   */
  pendingMark: () => Promise<void> | null;
} {
  const openedAsDraft = useRef(!chatId);
  const request = useRef<Promise<void> | null>(null);
  const [watermark, setWatermark] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<ReadonlySet<string> | null | undefined>(undefined);
  const [olderIds, setOlderIds] = useState<ReadonlySet<string>>(new Set());

  // The request starts in an effect that runs before the one that loads the
  // chat's messages, and nothing marks the chat read before that load.
  useEffect(() => {
    if (!chatId || !loadReadMark || openedAsDraft.current || request.current) return;
    request.current = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, MARK_WAIT_MS);
      void loadReadMark(chatId)
        .then(setWatermark)
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  }, [chatId, loadReadMark]);

  const noteOpened = useCallback(
    (messages: ChatMessage[]) =>
      setOpenIds((current) =>
        current === undefined
          ? messages.length > 0
            ? new Set(messages.map((message) => message.id))
            : null
          : current,
      ),
    [],
  );
  const liveIds = useRef(new Set<string>());
  const noteLive = useCallback((id: string) => void liveIds.current.add(id), []);
  const noteOlder = useCallback(
    (messages: ChatMessage[]) =>
      setOlderIds(
        (current) =>
          new Set([
            ...current,
            ...messages.map((message) => message.id).filter((id) => !liveIds.current.has(id)),
          ]),
      ),
    [],
  );
  const pendingMark = useCallback(() => request.current, []);
  const unread = useMemo(
    () =>
      watermark && openIds ? { watermark, memberIds: new Set([...openIds, ...olderIds]) } : null,
    [watermark, openIds, olderIds],
  );
  return { unread, noteOpened, noteOlder, noteLive, pendingMark };
}
