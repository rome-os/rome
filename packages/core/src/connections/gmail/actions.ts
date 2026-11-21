import { hashArgs } from "../../apps/actions/replay.js";
import { z } from "zod";
import type { ActionRegistry, ActionResult } from "../../apps/actions/types.js";
import { approvedSendId as approvalId, type ApprovedSendOptions } from "../approved-send.js";
import type { ConnectionRegistry } from "../registry.js";
import { gmailReadSchema, gmailSendSchema, type GmailResponse } from "./api.js";

export const GMAIL_READ_ACTION = "core:gmail_read";
export const GMAIL_SEND_ACTION = "core:gmail_send";

function response(result: unknown, connectionId: string): ActionResult {
  const reply = result as GmailResponse;
  if (reply.status < 200 || reply.status >= 300) {
    return { status: "error", error: `Gmail API returned HTTP ${reply.status}.` };
  }
  return { status: "ok", data: { ...reply, connectionId } };
}

export function registerGmailActions(
  actions: Pick<ActionRegistry, "register">,
  connections: Pick<ConnectionRegistry, "find" | "grantOf"> | undefined,
  options: ApprovedSendOptions = {},
): void {
  actions.register({
    config: {
      name: GMAIL_READ_ACTION,
      type: "system",
      description:
        "Read the Rome-managed Google mailbox. GET only: /gmail/v1/users/me/profile, /messages, /messages/{id}, /threads, /threads/{id}. Query options include q, maxResults, pageToken, format. No modifying, deleting, or labeling mail. Attachment downloads are not supported through this connection. Returns connectionId for core:gmail_send; profile returns the From emailAddress. If gmail_not_connected, Gmail can still be used through Composio. Connect Google in Settings → Connections (SHOW_GOOGLE_OAUTH is opt-in until verification).",
      complexity: "simple",
      speed: "moderate",
      reliability: "high",
      sideEffects: "read-only",
    },
    // Accept proxy-shaped candidates so an absent Google connection can fall
    // back to Composio. The strict read-only schema runs after that check.
    inputSchema: z.toJSONSchema(
      z
        .object({
          path: z.string(),
          method: z.string().optional(),
          host: z.string().optional(),
          query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
          body: z.unknown().optional(),
          headers: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
    ),
    async execute(args) {
      if (options.forward) return options.forward(GMAIL_READ_ACTION, args);
      if (!connections) return { status: "error", error: "Gmail service unavailable." };
      const found = connections.find("google").filter((connection) => connection.state() !== null);
      if (found.length === 0)
        return {
          status: "error",
          error: "gmail_not_connected: No Rome-managed Google connection.",
        };
      if (found.length !== 1)
        return {
          status: "error",
          error: "Gmail connection is ambiguous. Fix Google in Settings → Connections.",
        };
      const scopes = (await connections.grantOf(found[0].id))?.profile?.scopes;
      if (
        !Array.isArray(scopes) ||
        !scopes.includes("https://www.googleapis.com/auth/gmail.readonly")
      ) {
        return {
          status: "error",
          error:
            "gmail_not_connected: Google has no Gmail read permission. Reconnect Google to grant it, or use Composio.",
        };
      }
      const parsed = gmailReadSchema.safeParse(args);
      if (!parsed.success)
        return {
          status: "error",
          error:
            "Only Gmail profile, message and thread GETs without custom headers or body are allowed. Send with core:gmail_send; every message requires guardian approval.",
        };
      if (found.length !== 1 || !found[0].act)
        return {
          status: "error",
          error: "Gmail connection unavailable. Fix Google in Settings → Connections.",
        };
      try {
        return response(
          await found[0].act.invoke({ operation: "read", input: parsed.data }),
          found[0].id,
        );
      } catch {
        return {
          status: "error",
          error: "Gmail read failed. Check the Google connection and retry.",
        };
      }
    },
  });
  actions.register({
    config: {
      name: GMAIL_SEND_ACTION,
      type: "system",
      description:
        "Send one plain-text Gmail message through Rome-managed Google, only after the guardian approves this exact From/To/Subject/Body on the approval card. First read /gmail/v1/users/me/profile with core:gmail_read to get connectionId and From emailAddress. For a reply, supply inReplyTo (the original Message-ID header), threadId from the thread read, and a matching subject. No attachments, Cc, Bcc, draft mutation or raw MIME. Every invocation requires a fresh approval, including scheduled and nested calls.",
      complexity: "simple",
      speed: "moderate",
      reliability: "high",
      sideEffects: "write",
      requiresApproval: true,
    },
    inputSchema: z.toJSONSchema(gmailSendSchema),
    preview(args) {
      const parsed = gmailSendSchema.safeParse(args);
      if (!parsed.success)
        return {
          kind: "generic",
          title: "Send Gmail message",
          summary: "Invalid message; nothing will be sent.",
        };
      const input = parsed.data;
      return {
        kind: "generic",
        title: "Send Gmail message",
        summary: "Send this exact message from your connected Google account.",
        fields: [
          { label: "From", value: input.from },
          { label: "To", value: input.to.join(", ") },
          { label: "Subject", value: input.subject },
          { label: "Body", value: input.body },
          ...(input.threadId ? [{ label: "Gmail thread", value: input.threadId }] : []),
          ...(input.inReplyTo ? [{ label: "In reply to", value: input.inReplyTo }] : []),
        ],
      };
    },
    async execute(args) {
      if (options.forward) return options.forward(GMAIL_SEND_ACTION, args, approvalId());
      if (!connections) return { status: "error", error: "Gmail service unavailable." };
      const parsed = gmailSendSchema.safeParse(args);
      if (!parsed.success)
        return { status: "error", error: "Invalid Gmail message. Nothing was sent." };
      const connection = connections
        .find("google")
        .find((entry) => entry.id === parsed.data.connectionId);
      if (!connection?.act)
        return {
          status: "error",
          error: "The approved Google connection is unavailable. Nothing was sent.",
        };
      const scopes = (await connections.grantOf(connection.id))?.profile?.scopes;
      if (
        !Array.isArray(scopes) ||
        !scopes.includes("https://www.googleapis.com/auth/gmail.send") ||
        !scopes.includes("https://www.googleapis.com/auth/gmail.readonly")
      ) {
        return {
          status: "error",
          error:
            "The approved Google connection needs Gmail read and send permissions. Reconnect Google. Nothing was sent.",
        };
      }
      const approved = approvalId();
      if (
        !approved ||
        !options.claimApprovedSend ||
        !(await options.claimApprovedSend(approved, hashArgs(parsed.data)))
      ) {
        return {
          status: "error",
          error: "This exact Gmail message has no unused guardian approval. Nothing was sent.",
        };
      }
      try {
        return response(
          await connection.act.invoke({ operation: "send", input: parsed.data }),
          connection.id,
        );
      } catch {
        // A timeout after Gmail accepted a message cannot safely be retried automatically.
        return {
          status: "error",
          error:
            "Gmail send failed or its outcome is unknown. Check Sent mail before requesting a new approval; do not automatically retry.",
        };
      }
    },
  });
}
