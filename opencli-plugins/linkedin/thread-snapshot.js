// Overrides clis/linkedin/thread-snapshot.js from @yunfanye/opencli 1.8.8.
// Keep the API URL discovery in sync when upstream changes LinkedIn messaging queries.
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import {
  LINKEDIN_DOMAIN,
  fetchFirstConversationPayload,
  fetchThreadPayload,
  openThread,
  readThreadCsrf,
  requireCurrentThread,
  requireThreadUrl,
  waitForThreadProbe,
} from "./thread-read.mjs";
import {
  DEFAULT_THREAD_MESSAGE_LIMIT,
  MAX_THREAD_MESSAGE_LIMIT,
  countThreadMessagesInPayload,
  discoverOlderThreadApi,
  linkedInThreadId,
  normalizeThreadMessageLimit,
  parseThreadMessagePayloads,
  unwrapThreadBrowserResult,
} from "./thread-snapshot-helpers.mjs";

const COMMAND = "thread-snapshot";
const MAX_API_DISCOVERY_ROUNDS = Math.ceil(MAX_THREAD_MESSAGE_LIMIT / 20) + 3;

cli({
  site: "linkedin",
  name: "thread-snapshot",
  access: "read",
  description: "Return the latest messages and sender metadata from one LinkedIn thread",
  example:
    "opencli linkedin thread-snapshot --thread-url https://www.linkedin.com/messaging/thread/<id>/ --limit 20 -f json",
  domain: LINKEDIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "thread-url",
      type: "string",
      required: true,
      help: "Exact LinkedIn messaging thread URL to read",
    },
    {
      name: "limit",
      type: "int",
      default: DEFAULT_THREAD_MESSAGE_LIMIT,
      help: `Latest messages to return (1-${MAX_THREAD_MESSAGE_LIMIT})`,
    },
  ],
  columns: [
    "thread_url",
    "thread_id",
    "conversation_name",
    "conversation_title",
    "conversation_is_group",
    "participant_count",
    "returned_index",
    "returned_message_count",
    "message_id",
    "sent_at",
    "sender_participant_id",
    "sender_name",
    "sender_type",
    "sender_profile_url",
    "sender_headline",
    "sender_is_self",
    "text",
    "subject",
    "reaction_count",
    "is_latest",
  ],
  func: async (page, kwargs) => {
    if (!page) {
      throw new CommandExecutionError("Browser session required for linkedin thread-snapshot");
    }

    const threadUrl = requireThreadUrl(kwargs["thread-url"]);
    const threadId = linkedInThreadId(threadUrl);
    let limit;
    try {
      limit = normalizeThreadMessageLimit(kwargs.limit);
    } catch (error) {
      throw new ArgumentError(error instanceof Error ? error.message : String(error));
    }

    await openThread(page, threadUrl);

    const probe = await waitForThreadProbe(page, threadId);
    requireCurrentThread(probe, threadUrl, COMMAND);
    if (!probe?.initial_url) {
      throw new CommandExecutionError(
        "LinkedIn did not issue a message request for the requested thread.",
      );
    }

    const csrf = await readThreadCsrf(page);
    const payloads = [];
    const fetchedUrls = new Set();

    // Optional metadata must not block message retrieval.
    const conversationPayload = await fetchFirstConversationPayload(
      page,
      probe,
      csrf,
      threadId,
      COMMAND,
    );
    if (conversationPayload) payloads.push(conversationPayload);

    const consume = async (apiUrl) => {
      if (!apiUrl || fetchedUrls.has(apiUrl)) return { added: 0, fetched: false };
      fetchedUrls.add(apiUrl);
      const payload = await fetchThreadPayload(page, apiUrl, csrf, threadId, COMMAND);
      payloads.push(payload);
      return { added: countThreadMessagesInPayload(payload, threadId), fetched: true };
    };

    await consume(probe.initial_url);
    let exhausted = false;
    for (const pageUrl of Array.isArray(probe.page_urls) ? probe.page_urls : []) {
      if (parseThreadMessagePayloads(payloads, { threadId, threadUrl, limit }).length >= limit) {
        break;
      }
      const result = await consume(pageUrl);
      if (result.fetched && result.added === 0) {
        exhausted = true;
        break;
      }
    }

    for (let round = 0; round < MAX_API_DISCOVERY_ROUNDS && !exhausted; round += 1) {
      const before = parseThreadMessagePayloads(payloads, { threadId, threadUrl, limit });
      if (before.length >= limit) break;
      const discovered = unwrapThreadBrowserResult(
        await page.evaluate(discoverOlderThreadApi, threadId, [...fetchedUrls]),
      );
      if (!discovered?.message_list_found) {
        throw new CommandExecutionError("LinkedIn did not render the active thread message list.");
      }
      if (!discovered.api_url) break;
      const result = await consume(discovered.api_url);
      if (!result.fetched || result.added === 0) {
        exhausted = true;
        break;
      }
      const after = parseThreadMessagePayloads(payloads, { threadId, threadUrl, limit });
      if (after.length <= before.length) break;
    }

    try {
      return parseThreadMessagePayloads(payloads, { threadId, threadUrl, limit });
    } catch (error) {
      throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }
  },
});
