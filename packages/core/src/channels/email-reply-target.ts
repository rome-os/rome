import type { MailProvider } from "../lib/rome-cloud-mail.js";

const PAGE_SIZE = 100;
const MAX_MESSAGES = 2000;
const MAX_PAGES = 20;

/**
 * Resolve a thread within the provider's newest 2,000 messages and 20 pages.
 * Reads metadata only, without a time cutoff or any adapter-state changes.
 * A miss never authorizes a new email. Pass an explicit message ID to bypass
 * these lookup bounds. Provider errors propagate without a send attempt.
 */
export async function resolveEmailReplyTarget(
  provider: Pick<MailProvider, "listMessages">,
  threadId: string,
): Promise<string> {
  let pageToken: string | undefined;
  let scanned = 0;
  const visited = new Set<string>();

  for (let pageIndex = 0; pageIndex < MAX_PAGES && scanned < MAX_MESSAGES; pageIndex += 1) {
    const page = await provider.listMessages({
      ascending: false,
      limit: Math.min(PAGE_SIZE, MAX_MESSAGES - scanned),
      pageToken,
    });
    for (const item of page.messages) {
      if (scanned >= MAX_MESSAGES) break;
      scanned += 1;
      if (item.threadId === threadId && item.providerMessageId?.trim()) {
        return item.providerMessageId;
      }
    }
    const next = page.nextPageToken;
    if (!next || visited.has(next)) break;
    visited.add(next);
    pageToken = next;
  }

  throw new Error(
    `Cannot resolve email thread "${threadId}" within the reply lookup limits. ` +
      "No email was sent. Supply a provider message ID as `replyToMessageId`, " +
      "or omit `threadId` and set `to` to start a new email.",
  );
}
