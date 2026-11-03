import type { MailProvider, RomeMailListItem } from "../lib/rome-cloud-mail.js";

const PAGE_SIZE = 100;
const MAX_MESSAGES = 2000;
const MAX_PAGES = 20;

/**
 * Time a thread lookup may take. An action reaches the adapter through the
 * `channels.send` worker RPC, so the lookup and the mail request after it must
 * both finish inside that RPC's 30s deadline, with room to spare. Otherwise the
 * action could fail while the send is still in flight. `email-delivery.test.ts`
 * checks this budget against both timeouts.
 */
export const REPLY_LOOKUP_BUDGET_MS = 10_000;

/** A message to reply to, and whether this inbox sent it. */
export interface EmailReplyTarget {
  messageId: string;
  outbound: boolean;
}

/**
 * A resolved target. `complete` is false when the lookup stopped early, at the
 * time budget or a failed page, before it read every page its bounds allow.
 */
export interface ResolvedEmailReplyTarget extends EmailReplyTarget {
  complete: boolean;
}

export interface ResolveEmailReplyTargetOptions {
  /** Whether a listed message is one this inbox sent. */
  isOutbound: (item: RomeMailListItem) => boolean;
  budgetMs?: number;
}

/**
 * Resolve a thread to a provider message to reply to. Prefers the newest
 * message the inbox received, so a reply addresses the other party. Falls back
 * to the newest message the inbox sent when the thread has no received mail.
 *
 * Scans the provider's newest 2,000 messages across at most 20 pages, reading
 * metadata only. When the time budget runs out or a later page fails, it
 * returns the sent fallback if it has one, and otherwise rejects. A miss or a
 * timeout never authorizes a new email. Without a fallback, provider errors
 * propagate without a send attempt.
 */
export async function resolveEmailReplyTarget(
  provider: Pick<MailProvider, "listMessages">,
  threadId: string,
  options: ResolveEmailReplyTargetOptions,
): Promise<ResolvedEmailReplyTarget> {
  const { isOutbound } = options;
  const budgetMs = options.budgetMs ?? REPLY_LOOKUP_BUDGET_MS;
  const state: ScanState = { expired: false };
  const fallback = (): ResolvedEmailReplyTarget | undefined =>
    state.sentFallback
      ? { messageId: state.sentFallback, outbound: true, complete: false }
      : undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ResolvedEmailReplyTarget>((resolve, reject) => {
    timer = setTimeout(() => {
      state.expired = true;
      const found = fallback();
      if (found) {
        resolve(found);
        return;
      }
      reject(
        new Error(
          `Looking up email thread "${threadId}" took longer than ${budgetMs / 1000}s. ` +
            "No email was sent. Retry, or supply a provider message ID as `replyToMessageId`.",
        ),
      );
    }, budgetMs);
  });
  // A message already found in the thread outranks a failed later page, as it
  // does when the budget runs out.
  const scanned = scan(provider, threadId, isOutbound, state).catch((err: unknown) => {
    const found = fallback();
    if (found) return found;
    throw err;
  });

  try {
    return await Promise.race([scanned, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface ScanState {
  expired: boolean;
  sentFallback?: string;
}

async function scan(
  provider: Pick<MailProvider, "listMessages">,
  threadId: string,
  isOutbound: (item: RomeMailListItem) => boolean,
  state: ScanState,
): Promise<ResolvedEmailReplyTarget> {
  let pageToken: string | undefined;
  let scanned = 0;
  const visited = new Set<string>();

  for (let pageIndex = 0; pageIndex < MAX_PAGES && scanned < MAX_MESSAGES; pageIndex += 1) {
    // The deadline already settled the lookup; stop reading pages nobody awaits.
    if (state.expired) break;
    const page = await provider.listMessages({
      ascending: false,
      limit: Math.min(PAGE_SIZE, MAX_MESSAGES - scanned),
      pageToken,
    });
    for (const item of page.messages) {
      if (scanned >= MAX_MESSAGES) break;
      scanned += 1;
      const messageId = item.providerMessageId?.trim();
      if (item.threadId !== threadId || !messageId) continue;
      if (!isOutbound(item)) return { messageId, outbound: false, complete: true };
      state.sentFallback ??= messageId;
    }
    const next = page.nextPageToken;
    if (!next || visited.has(next)) break;
    visited.add(next);
    pageToken = next;
  }

  if (state.sentFallback) return { messageId: state.sentFallback, outbound: true, complete: true };
  throw new Error(
    `Cannot resolve email thread "${threadId}" within the reply lookup limits. ` +
      "No email was sent. Supply a provider message ID as `replyToMessageId`, " +
      "or omit `threadId` and set `to` to start a new email.",
  );
}
