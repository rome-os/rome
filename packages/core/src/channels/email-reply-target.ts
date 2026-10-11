import { DEFAULT_RPC_TIMEOUT_MS } from "../actions/ipc.js";
import {
  MAIL_REQUEST_TIMEOUT_MS,
  type MailProvider,
  type RomeMailListItem,
} from "../lib/rome-cloud-mail.js";

const PAGE_SIZE = 100;
const MAX_MESSAGES = 2000;
const MAX_PAGES = 20;
// Headroom for the RPC hop and adapter work around the lookup and the send.
const DEADLINE_MARGIN_MS = 5_000;

/**
 * Time a thread lookup may take. An action reaches the adapter through the
 * `channels.send` RPC, so the lookup and the provider send that follows it
 * must both finish inside that RPC's deadline. Otherwise the action could
 * fail while the send is still in flight and later succeeds.
 */
export const REPLY_LOOKUP_BUDGET_MS =
  DEFAULT_RPC_TIMEOUT_MS - MAIL_REQUEST_TIMEOUT_MS - DEADLINE_MARGIN_MS;

export interface ResolveEmailReplyTargetOptions {
  /** Whether a listed message is one this inbox sent. Defaults to the `sent` label. */
  isOutbound?: (item: RomeMailListItem) => boolean;
  budgetMs?: number;
}

/**
 * Resolve a thread to a provider message ID to reply to. Prefers the newest
 * message the inbox received, so a reply addresses the other party. Falls back
 * to the newest message the inbox sent when the thread has no received mail.
 *
 * Scans the provider's newest 2,000 messages across at most 20 pages, reading
 * metadata only. When the time budget runs out it returns the sent fallback if
 * it has one, and otherwise rejects. A miss or a timeout never authorizes a
 * new email. Provider errors propagate without a send attempt.
 */
export async function resolveEmailReplyTarget(
  provider: Pick<MailProvider, "listMessages">,
  threadId: string,
  options: ResolveEmailReplyTargetOptions = {},
): Promise<string> {
  const isOutbound = options.isOutbound ?? ((item) => item.labels.includes("sent"));
  const budgetMs = options.budgetMs ?? REPLY_LOOKUP_BUDGET_MS;
  const state: { expired: boolean; sentFallback?: string } = { expired: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      state.expired = true;
      if (state.sentFallback) {
        resolve(state.sentFallback);
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

  try {
    return await Promise.race([scan(provider, threadId, isOutbound, state), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function scan(
  provider: Pick<MailProvider, "listMessages">,
  threadId: string,
  isOutbound: (item: RomeMailListItem) => boolean,
  state: { expired: boolean; sentFallback?: string },
): Promise<string> {
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
      if (!isOutbound(item)) return messageId;
      state.sentFallback ??= messageId;
    }
    const next = page.nextPageToken;
    if (!next || visited.has(next)) break;
    visited.add(next);
    pageToken = next;
  }

  if (state.sentFallback) return state.sentFallback;
  throw new Error(
    `Cannot resolve email thread "${threadId}" within the reply lookup limits. ` +
      "No email was sent. Supply a provider message ID as `replyToMessageId`, " +
      "or omit `threadId` and set `to` to start a new email.",
  );
}
