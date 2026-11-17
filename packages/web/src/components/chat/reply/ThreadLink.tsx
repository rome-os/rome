// A link to a chat thread in the Concierge's text, as a small chip
// (docs/domains/chats.md#chat-thread). It opens the thread in focus.

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useChatThreads } from "./chat-threads";
import { useReplyDraft } from "./reply-draft";

const CHIP =
  "inline-flex max-w-full items-center rounded-full border border-border bg-surface px-2 align-baseline text-aux text-foreground";

/**
 * The chip for the thread whose root is `root`: "# name", with the thread's
 * live name, else `fallback`, the link's own text, else a generic name. It
 * opens the thread when the timeline holds one by that root and none is in
 * focus. A thread the timeline does not hold, which has replies nowhere to be
 * read, is the same chip, plain.
 */
export function ThreadLink({ root, fallback }: { root: string; fallback?: string }) {
  const { t } = useTranslation("chat");
  const threads = useChatThreads();
  const draft = useReplyDraft();
  const title = threads?.titles.get(root) || fallback || t("thread.untitled");
  const label = <span className="truncate">{`# ${title}`}</span>;
  if (!threads || threads.roots.get(root) !== root || !draft?.threads || draft.thread !== null) {
    return <span className={CHIP}>{label}</span>;
  }
  return (
    <button
      type="button"
      aria-label={t("thread.open", { title })}
      onClick={() => draft.openThread({ thread: root, title: threads.titles.get(root) ?? "" })}
      className={cn(
        CHIP,
        "cursor-pointer transition-colors hover:bg-surface-muted",
        "outline-1 outline-offset-2 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50",
      )}
    >
      {label}
    </button>
  );
}
