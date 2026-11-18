// The row of pills above the composer, one for each thread with replies the
// owner has not seen (docs/domains/chats.md#chat-thread).

import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import type { ChatThreads } from "./chat-threads";

/** How many letters of a thread's name a pill shows. */
const NAME_MAX = 12;

function shortName(name: string): string {
  const letters = Array.from(name);
  return letters.length > NAME_MAX ? `${letters.slice(0, NAME_MAX).join("").trimEnd()}…` : name;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The roots of the threads that wait for the reader with a pill: those of
 * `threads` that have unread replies, oldest waiting first.
 */
export function waitingThreads(threads: ChatThreads): string[] {
  if (threads.focus) return [];
  return [...threads.stacks.values()]
    .filter((stack) => stack.unread > 0)
    .sort((a, b) => a.unreadAt - b.unreadAt)
    .map((stack) => stack.root);
}

/**
 * One pill for each thread of `threads` that has unread replies, oldest
 * waiting first, in one row that scrolls sideways when it is too long. A pill
 * goes with `onPick`, which leaves the thread closed. Nothing shows with a
 * thread in focus. A thread whose stack is in `visible` has no pill while the
 * reader sees the stack, and gets it back when the stack scrolls out of view
 * with the thread still unread.
 */
export function ThreadPills({
  threads,
  onPick,
  visible = NONE,
}: {
  threads: ChatThreads;
  onPick: (root: string) => void;
  visible?: ReadonlySet<string>;
}) {
  const { t } = useTranslation("chat");
  const waiting = waitingThreads(threads).filter((root) => !visible.has(root));
  if (waiting.length === 0) return null;
  return (
    <div
      data-thread-pills
      className="mb-2 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {waiting.map((root) => (
        <button
          key={root}
          type="button"
          data-thread-pill={root}
          onClick={() => onPick(root)}
          className="flex shrink-0 cursor-pointer items-center gap-2 rounded-full border border-border bg-surface/95 py-1 pr-3 pl-2 text-aux whitespace-nowrap text-foreground shadow-4 backdrop-blur-md outline-1 outline-offset-2 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
          <AgentAvatar size="sm" className="data-[size=sm]:size-4" />
          <span>
            {t("thread.newReplies", {
              title: shortName(threads.titles.get(root) || t("thread.untitled")),
            })}
          </span>
        </button>
      ))}
    </div>
  );
}
