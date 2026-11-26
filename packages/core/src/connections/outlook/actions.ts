import { hashArgs } from "../../apps/actions/replay.js";
import { z } from "zod";
import type { ActionRegistry, ActionResult } from "../../apps/actions/types.js";
import { approvedSendId, type ApprovedSendOptions } from "../approved-send.js";
import type { ConnectionRegistry } from "../registry.js";
import { outlookReadSchema, outlookSendSchema, type OutlookResponse } from "./api.js";

export const OUTLOOK_READ_ACTION = "core:outlook_read";
export const OUTLOOK_SEND_ACTION = "core:outlook_send";

/** Microsoft reports Graph scopes either bare or with the Graph resource prefix. */
function hasScope(scopes: unknown, scope: string): boolean {
  return (
    Array.isArray(scopes) &&
    scopes.some(
      (granted) =>
        typeof granted === "string" &&
        [scope, `https://graph.microsoft.com/${scope}`].includes(granted),
    )
  );
}

function response(result: unknown, connectionId: string): ActionResult {
  const reply = result as OutlookResponse;
  if (reply.status < 200 || reply.status >= 300) {
    return { status: "error", error: `Microsoft Graph returned HTTP ${reply.status}.` };
  }
  return { status: "ok", data: { ...reply, connectionId } };
}

export function registerOutlookActions(
  actions: Pick<ActionRegistry, "register">,
  connections: Pick<ConnectionRegistry, "find" | "grantOf"> | undefined,
  options: ApprovedSendOptions = {},
): void {
  actions.register({
    config: {
      name: OUTLOOK_READ_ACTION,
      type: "system",
      description:
        "Read the Rome-managed Microsoft (Outlook) mailbox through Microsoft Graph. GET only: /v1.0/me, /v1.0/me/messages, /v1.0/me/messages/{id}, /v1.0/me/mailFolders, /v1.0/me/mailFolders/{id}, /v1.0/me/mailFolders/{id}/messages. Query options: $select, $filter, $search, $top, $skip, $orderby, $count. No modifying, moving, deleting or flagging mail, and no attachments. Returns connectionId for core:outlook_send; /v1.0/me returns the sender address (mail, else userPrincipalName). Calendar, contacts and other Graph APIs stay on Composio. outlook_not_connected means no Rome-managed Microsoft connection reads Outlook mail: Outlook is then the Composio Outlook connection, for reading and for sending with its own tools. Suggest connecting Microsoft only when connect_service takes kind microsoft or core:concierge_following_list lists a microsoft service.",
      complexity: "simple",
      speed: "moderate",
      reliability: "high",
      sideEffects: "read-only",
    },
    // Accept proxy-shaped candidates so an absent Microsoft connection can fall
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
      if (options.forward) return options.forward(OUTLOOK_READ_ACTION, args);
      if (!connections) return { status: "error", error: "Outlook service unavailable." };
      const found = connections
        .find("microsoft")
        .filter((connection) => connection.state() !== null);
      if (found.length === 0)
        return {
          status: "error",
          error: "outlook_not_connected: No Rome-managed Microsoft connection.",
        };
      if (found.length !== 1)
        return {
          status: "error",
          error:
            "outlook_connection_broken: Outlook connection is ambiguous. Fix Microsoft in Settings → Connections.",
        };
      // A grant that never had mail access leaves Outlook on Composio, even when broken.
      const scopes = (await connections.grantOf(found[0].id))?.profile?.scopes;
      if (!hasScope(scopes, "Mail.Read")) {
        return {
          status: "error",
          error:
            "outlook_not_connected: Microsoft has no Outlook read permission. Reconnect Microsoft to grant it, or use Composio.",
        };
      }
      if (!found[0].act)
        return {
          status: "error",
          error:
            "outlook_connection_broken: Outlook connection is unavailable. Fix Microsoft in Settings → Connections.",
        };
      const parsed = outlookReadSchema.safeParse(args);
      if (!parsed.success)
        return {
          status: "error",
          error:
            "Only Outlook profile, message and mail folder GETs without custom headers or body are allowed. Send with core:outlook_send; every message requires guardian approval.",
        };
      try {
        return response(
          await found[0].act.invoke({ operation: "read", input: parsed.data }),
          found[0].id,
        );
      } catch {
        return {
          status: "error",
          error: "Outlook read failed. Check the Microsoft connection and retry.",
        };
      }
    },
  });
  actions.register({
    config: {
      name: OUTLOOK_SEND_ACTION,
      type: "system",
      description:
        "Send one new plain-text Outlook message through Rome-managed Microsoft, only after the guardian approves this exact From/To/Subject/Body on the approval card. First read /v1.0/me with core:outlook_read to get connectionId and the From address. To answer a message, send a new message to its sender with a matching subject; it is not threaded as an Outlook reply. No attachments, Cc, Bcc or drafts. Every invocation requires a fresh approval, including scheduled and nested calls. Only for a Rome-managed Microsoft connection: with none, send through the Composio Outlook connection's tools. outlook_send_not_granted means the connection lacks send permission, and outlook_connection_broken that it is broken: ask the guardian to reconnect Microsoft in Settings → Connections. outlook_connection_changed means the connectionId is stale: read /v1.0/me again and follow its answer. Never answer outlook_send_not_granted or outlook_connection_broken by sending through Composio or another mailbox.",
      complexity: "simple",
      speed: "moderate",
      reliability: "high",
      sideEffects: "write",
      requiresApproval: true,
    },
    inputSchema: z.toJSONSchema(outlookSendSchema),
    preview(args) {
      const parsed = outlookSendSchema.safeParse(args);
      if (!parsed.success)
        return {
          kind: "generic",
          title: "Send Outlook message",
          summary: "Invalid message; nothing will be sent.",
        };
      const input = parsed.data;
      return {
        kind: "generic",
        title: "Send Outlook message",
        summary: "Send this exact message from your connected Microsoft account.",
        fields: [
          { label: "From", value: input.from },
          { label: "To", value: input.to.join(", ") },
          { label: "Subject", value: input.subject },
          { label: "Body", value: input.body },
        ],
      };
    },
    async execute(args) {
      if (options.forward) return options.forward(OUTLOOK_SEND_ACTION, args, approvedSendId());
      if (!connections) return { status: "error", error: "Outlook service unavailable." };
      const parsed = outlookSendSchema.safeParse(args);
      if (!parsed.success)
        return { status: "error", error: "Invalid Outlook message. Nothing was sent." };
      const connection = connections
        .find("microsoft")
        .find((entry) => entry.id === parsed.data.connectionId);
      if (!connection)
        return {
          status: "error",
          error:
            "outlook_connection_changed: No Rome-managed Microsoft connection has this connectionId. Read /v1.0/me again: send with its connectionId, or through Composio only if it answers outlook_not_connected. Nothing was sent.",
        };
      if (!connection.act)
        return {
          status: "error",
          error:
            "outlook_connection_broken: The approved Microsoft connection is unavailable. Reconnect Microsoft in Settings → Connections. Nothing was sent.",
        };
      const scopes = (await connections.grantOf(connection.id))?.profile?.scopes;
      if (!hasScope(scopes, "Mail.Send") || !hasScope(scopes, "User.Read")) {
        return {
          status: "error",
          error:
            "outlook_send_not_granted: Microsoft is connected, but without permission to send Outlook mail. Reconnect Microsoft in Settings → Connections to grant sending. Nothing was sent.",
        };
      }
      const approved = approvedSendId();
      if (
        !approved ||
        !options.claimApprovedSend ||
        !(await options.claimApprovedSend(approved, hashArgs(parsed.data)))
      ) {
        return {
          status: "error",
          error: "This exact Outlook message has no unused guardian approval. Nothing was sent.",
        };
      }
      try {
        return response(
          await connection.act.invoke({ operation: "send", input: parsed.data }),
          connection.id,
        );
      } catch {
        // A timeout after Microsoft accepted a message cannot safely be retried automatically.
        return {
          status: "error",
          error:
            "Outlook send failed or its outcome is unknown. Check Sent Items before requesting a new approval; do not automatically retry.",
        };
      }
    },
  });
}
