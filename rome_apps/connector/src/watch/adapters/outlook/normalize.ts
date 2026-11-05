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
    str(obj(obj(supplied.from).emailAddress).address) !== undefined ||
    str(obj(obj(supplied.sender).emailAddress).address) !== undefined ||
    str(supplied.subject) !== undefined ||
    str(supplied.bodyPreview) !== undefined ||
    str(obj(supplied.body).content) !== undefined;
  const message = await ctx.reads.outlookMessage(id).catch((error: unknown) => {
    if (showable) return supplied;
    throw error;
  });
  const me = ctx.address.toLowerCase();
  const from = obj(obj(message.from).emailAddress);
  const sender = str(from.address)?.toLowerCase();
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
  const name = str(from.name);
  return keep("outlook", `${me}:${id}`, "new_mail", {
    ...(name || sender ? { actor: name && sender ? `${name} <${sender}>` : (name ?? sender) } : {}),
    subject: str(message.subject),
    url: str(message.webLink),
    text: str(message.bodyPreview),
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
