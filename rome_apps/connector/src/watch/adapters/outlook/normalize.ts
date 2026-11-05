// New Outlook mail in the common shape. The trigger gives the message id and,
// when Composio has them, some of its fields. The message is read by id, so
// its sender, recipients, headers and Focused Inbox tab are known either way.

import { drop, KIND_OFF, keep, obj, str } from "../../shared/event.js";
import { BULK_PRECEDENCE, isAutomatedSender } from "../../shared/mail.js";
import type { AddressedTo, Json, Normalized } from "../../types.js";
import type { OutlookReads } from "./reads.js";

export interface OutlookContext {
  address: string;
  kinds: ReadonlySet<string>;
  reads: OutlookReads;
}

/** A Graph recipient's address, lower-cased. */
const addressOf = (recipient: unknown) =>
  str(obj(obj(recipient).emailAddress).address)?.toLowerCase();
const addressesOf = (recipients: unknown) =>
  (Array.isArray(recipients) ? recipients : [])
    .map(addressOf)
    .filter((a): a is string => a !== undefined);

/** Who a message is from: `from`, or `sender` when Outlook sends on someone's behalf. */
function fromOf(message: Json): { name?: string; address?: string } {
  for (const key of ["from", "sender"]) {
    const who = obj(obj(message[key]).emailAddress);
    const address = str(who.address)?.toLowerCase();
    const name = str(who.name);
    if (address || name) return { ...(name ? { name } : {}), ...(address ? { address } : {}) };
  }
  return {};
}

/** HTML as plain text: no tags, scripts or styles, and the common entities read. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/** What a message says: its preview, or its body as text. The excerpt cuts it to length. */
function textOf(message: Json): string | undefined {
  const preview = str(message.bodyPreview);
  if (preview) return preview;
  const body = obj(message.body);
  const content = str(body.content);
  if (!content) return undefined;
  return str(str(body.contentType)?.toLowerCase() === "html" ? htmlText(content) : content);
}

/** A new Outlook message in the common shape, or why it is not one. */
export async function normalizeOutlook(payload: Json, ctx: OutlookContext): Promise<Normalized> {
  if (!ctx.kinds.has("new_mail")) return drop(KIND_OFF);
  const id = str(payload.id);
  if (!id) return drop("no message id");
  const supplied = obj(payload.outlook_message ?? payload.message);
  // A failed read keeps what the trigger supplied when it says something: a
  // sender, a subject or a body. Otherwise the error reaches the follower, so
  // the mail is tried again rather than shown as nothing.
  const showable =
    fromOf(supplied).address !== undefined ||
    str(supplied.subject) !== undefined ||
    textOf(supplied) !== undefined;
  const message = await ctx.reads.outlookMessage(id).catch((error: unknown) => {
    if (showable) return supplied;
    throw error;
  });
  const me = ctx.address.toLowerCase();
  const from = fromOf(message);
  const sender = from.address;
  const to = addressesOf(message.toRecipients);
  const cc = addressesOf(message.ccRecipients);
  const headers = new Map(
    (Array.isArray(message.internetMessageHeaders) ? message.internetMessageHeaders : [])
      .map(obj)
      .flatMap((h) => {
        const name = str(h.name);
        return name
          ? [[name.toLowerCase(), typeof h.value === "string" ? h.value : ""] as const]
          : [];
      }),
  );
  const addressedTo: AddressedTo = to.includes(me) ? "direct" : cc.includes(me) ? "copy" : "other";
  const name = from.name;
  return keep("outlook", `${me}:${id}`, "new_mail", {
    ...(name || sender ? { actor: name && sender ? `${name} <${sender}>` : (name ?? sender) } : {}),
    subject: str(message.subject),
    url: str(message.webLink),
    text: textOf(message),
    byYou: sender === me,
    addressedTo,
    labels: [
      str(message.inferenceClassification)?.toLowerCase() === "other" && "not-focused",
      str(message.importance)?.toLowerCase() === "high" && "high-importance",
      sender !== undefined && isAutomatedSender(sender) && "automated",
      (headers.has("list-unsubscribe") || headers.has("list-id")) && "mailing-list",
      BULK_PRECEDENCE.test(headers.get("precedence")?.trim() ?? "") && "bulk",
    ],
  });
}
