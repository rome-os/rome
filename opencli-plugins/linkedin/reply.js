import { randomBytes, randomUUID } from "node:crypto";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import {
  LINKEDIN_DOMAIN,
  fetchFirstConversationPayload,
  openThread,
  readThreadCsrf,
  requireCurrentThread,
  requireThreadUrl,
  waitForThreadProbe,
} from "./thread-read.mjs";
import { linkedInThreadId, unwrapThreadBrowserResult } from "./thread-snapshot-helpers.mjs";
import {
  UNKNOWN_REPLY_OUTCOME,
  parseReplyReceipt,
  postLinkedInReply,
  verifiedReplyTarget,
} from "./reply-helpers.mjs";

cli({
  site: "linkedin",
  name: "reply",
  access: "write",
  description: "Reply to a verified direct conversation and return its provider message id",
  domain: LINKEDIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "thread-url", required: true, help: "Exact existing LinkedIn thread URL" },
    { name: "expected-recipient", required: true, help: "Recipient member id" },
    { name: "expected-self", required: true, help: "Sending account member id" },
    { name: "message", required: true, help: "Plain text reply, with whitespace preserved" },
    {
      name: "send",
      type: "bool",
      default: false,
      help: "Send the reply. Otherwise only verify the destination.",
    },
  ],
  columns: ["status", "thread_id", "message_id", "sent_at", "text"],
  func: async (page, args) => {
    if (!page) throw new CommandExecutionError("Browser session required for linkedin reply");
    const threadUrl = requireThreadUrl(args["thread-url"]);
    const threadId = linkedInThreadId(threadUrl);
    const text = args.message;
    const recipientId = args["expected-recipient"];
    const selfId = args["expected-self"];
    if (typeof text !== "string" || !text.trim())
      throw new ArgumentError("--message must contain text");
    if (
      ![recipientId, selfId].every(
        (id) => typeof id === "string" && /^ACoAA[A-Za-z0-9_-]+$/.test(id),
      ) ||
      recipientId === selfId
    ) {
      throw new ArgumentError("Expected two distinct LinkedIn member ids");
    }
    await openThread(page, threadUrl);
    const probe = await waitForThreadProbe(page, threadId);
    requireCurrentThread(probe, threadUrl, "reply");
    const csrf = await readThreadCsrf(page);
    const payload = await fetchFirstConversationPayload(page, probe, csrf, threadId, "reply");
    let target;
    try {
      target = verifiedReplyTarget(payload, { threadId, threadUrl, recipientId, selfId });
    } catch (error) {
      throw new CommandExecutionError(error.message);
    }
    if (!args.send) return [{ status: "verified_dry_run", thread_id: threadId }];

    const originToken = randomUUID();
    let result;
    try {
      result = unwrapThreadBrowserResult(
        await page.evaluate(
          postLinkedInReply,
          csrf,
          target,
          text,
          originToken,
          randomBytes(16).toString("latin1"),
          threadUrl,
        ),
      );
    } catch {
      throw new CommandExecutionError(UNKNOWN_REPLY_OUTCOME);
    }
    if (result?.auth_required)
      throw new AuthRequiredError(
        LINKEDIN_DOMAIN,
        "LinkedIn reply requires an active signed-in LinkedIn browser session.",
      );
    if (result?.error) throw new CommandExecutionError(result.error);
    if (!result?.json || result.uncertain) throw new CommandExecutionError(UNKNOWN_REPLY_OUTCOME);
    try {
      return [parseReplyReceipt(result.json, payload, { threadId, threadUrl, originToken })];
    } catch {
      throw new CommandExecutionError(UNKNOWN_REPLY_OUTCOME);
    }
  },
});
