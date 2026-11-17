// The link to a chat thread the Concierge writes in a message
// (docs/domains/chats.md#chat-thread).

/**
 * A link to a thread in a message's text: `<chat-thread root="MESSAGE_ID"/>`,
 * which the Concierge writes to point from the main line at a thread. It has
 * no meaning outside the dashboard, so text read as plain words leaves it out.
 */
const THREAD_LINK = /<chat-thread\s+root=(["'])([^"']+)\1\s*\/>/g;

/** Where a link to a thread stands in markdown, for the link component to draw as a chip. */
export const THREAD_LINK_HREF = "#rome-thread=";

/** `markdown` with each thread link turned into a markdown link to {@link THREAD_LINK_HREF}. */
export function withThreadLinks(markdown: string): string {
  return markdown.replace(
    THREAD_LINK,
    (_link, _quote, root: string) => `[#](${THREAD_LINK_HREF}${encodeURIComponent(root)})`,
  );
}

/** `text` without its thread links, for a quote or a preview. */
export function withoutThreadLinks(text: string): string {
  return text.replace(THREAD_LINK, "").replace(/ {2,}/g, " ");
}

/** The root a link made by {@link withThreadLinks} names, or null for any other href. */
export function threadOfLink(href: string | undefined): string | null {
  return href?.startsWith(THREAD_LINK_HREF)
    ? decodeURIComponent(href.slice(THREAD_LINK_HREF.length))
    : null;
}
