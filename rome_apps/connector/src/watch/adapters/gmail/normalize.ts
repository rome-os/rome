// A new Gmail message in the common shape: its sender, how it is addressed to
// the guardian, and labels for Gmail's tabs, automated senders and lists.
// Spam and trash are dropped.

import { drop, labelsOf, obj, str } from "../../shared/event.js";
import { addressesIn, BULK_PRECEDENCE, isAutomatedSender } from "../../shared/mail.js";
import { excerptOf, subjectOf } from "../../shared/text.js";
import type { AddressedTo, Json, Normalized } from "../../types.js";

const DROPPED_LABELS = ["SPAM", "TRASH"];
/** Gmail's tabs, as labels. */
const CATEGORIES: Record<string, string> = {
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_FORUMS: "forums",
  CATEGORY_UPDATES: "updates",
};

/** Composio names a field in snake case in one place and camel case in another. */
const field = (payload: Json, snake: string, camel: string) => payload[snake] ?? payload[camel];

/** The headers of the raw Gmail message, when the payload carries it. */
function headers(payload: Json): Map<string, string> {
  const raw = obj(payload.payload).headers;
  const out = new Map<string, string>();
  if (!Array.isArray(raw)) return out;
  for (const header of raw.map(obj)) {
    const name = str(header.name);
    const value = typeof header.value === "string" ? header.value : undefined;
    if (name && value !== undefined) out.set(name.toLowerCase(), value);
  }
  return out;
}

/** A new Gmail message in the common shape, or why it is not one. */
export function normalizeGmail(payload: Json, ctx: { address: string }): Normalized {
  const me = ctx.address.toLowerCase();
  const head = headers(payload);
  const labels = field(payload, "label_ids", "labelIds");
  const labelIds = Array.isArray(labels)
    ? labels.filter((l): l is string => typeof l === "string")
    : [];
  if (labelIds.some((label) => DROPPED_LABELS.includes(label))) return drop("spam or trash");
  const id = str(field(payload, "message_id", "messageId"));
  if (!id) return drop("no message id");

  const from = str(field(payload, "sender", "from")) ?? head.get("from");
  const [sender] = addressesIn(from);
  const to = addressesIn(str(field(payload, "to", "to")) ?? head.get("to"));
  const cc = addressesIn(head.get("cc") ?? str(field(payload, "cc", "cc")));
  const thread = str(field(payload, "thread_id", "threadId"));
  const preview = obj(payload.preview);
  const subject = subjectOf(str(payload.subject) ?? str(preview.subject) ?? head.get("subject"));
  const quoted = excerptOf(str(preview.body) ?? str(field(payload, "message_text", "messageText")));
  const recipient: AddressedTo = to.includes(me) ? "direct" : cc.includes(me) ? "copy" : "other";
  return {
    keep: true,
    event: {
      id: `gmail:${me}:${id}`,
      source: "gmail",
      kind: "new_mail",
      ...(from || sender ? { actor: from ?? sender } : {}),
      ...(subject ? { subject } : {}),
      ...(thread
        ? { url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(thread)}` }
        : {}),
      ...(quoted ? { excerpt: quoted } : {}),
      byYou: sender === me,
      addressedTo: recipient,
      labels: labelsOf(
        ...labelIds.map((label) => CATEGORIES[label]),
        labelIds.length > 0 && !labelIds.includes("INBOX") && "not-in-inbox",
        sender !== undefined && isAutomatedSender(sender) && "automated",
        (head.has("list-unsubscribe") || head.has("list-id")) && "mailing-list",
        BULK_PRECEDENCE.test(head.get("precedence")?.trim() ?? "") && "bulk",
      ),
    },
  };
}
