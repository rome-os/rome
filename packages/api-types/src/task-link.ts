// The link to a task chat the Concierge writes in a message, a plain Markdown
// link: `[name](#rome-task=CHAT_ID)` (docs/domains/chats.md#task-link). The
// dashboard and the iOS app draw it as a chip with the task chat's live name
// and status; anywhere else it reads as its text.

/** The start of the href of a link to a task chat, followed by the chat's id. */
export const TASK_LINK_HREF = "#rome-task=";

/** The task chat a link names, or null for any other href and for an id that does not decode. */
export function taskChatOfLink(href: string | undefined): string | null {
  if (!href?.startsWith(TASK_LINK_HREF)) return null;
  try {
    return decodeURIComponent(href.slice(TASK_LINK_HREF.length)) || null;
  } catch {
    return null;
  }
}

/** The link to task chat `chatId`, with `name` as its fallback text. */
export function taskLink(name: string, chatId: string): string {
  // A bracket or a line break would end the link text early.
  const text = name.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || "Task";
  return `[${text}](${TASK_LINK_HREF}${encodeURIComponent(chatId)})`;
}
