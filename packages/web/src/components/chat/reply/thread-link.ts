// The link to a chat thread the Concierge writes in a message, a plain
// Markdown link: `[thread name](#rome-thread=MESSAGE_ID)`
// (docs/domains/chats.md#chat-thread).

/** The start of the href of a link to a thread, followed by the thread's root. */
export const THREAD_LINK_HREF = "#rome-thread=";

/** The root a link names, or null for any other href and for a root that does not decode. */
export function threadOfLink(href: string | undefined): string | null {
  if (!href?.startsWith(THREAD_LINK_HREF)) return null;
  try {
    return decodeURIComponent(href.slice(THREAD_LINK_HREF.length));
  } catch {
    return null;
  }
}
