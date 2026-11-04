// Which new mail the Concierge hears of, and how one reads as an alert. Mail
// arrives through the connector's Composio trigger for new Gmail messages,
// which polls the inbox. The checks here drop bulk and automated mail before
// any model sees it; who wrote what, and whether it matters, is the model's call.

import type { AlertEvent } from "./alerts.js";

/** The connector trigger for new mail, and the bus event it publishes. */
export const GMAIL_TRIGGER_SLUG = "GMAIL_NEW_GMAIL_MESSAGE";
export const GMAIL_EVENT_NAME = "provider:event:gmail.gmail_new_gmail_message";
/** The trigger watches the inbox only. */
export const GMAIL_TRIGGER_CONFIG = { labelIds: ["INBOX"] };

const EXCERPT_CHARS = 300;
/** Gmail's own sorting: mail it filed as promotions or the like is not personal. */
const SKIPPED_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  "SPAM",
  "TRASH",
]);
/** Senders no person answers from. */
const AUTOMATED_SENDER =
  /^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?)([+._-][^@]*)?@/i;
const BULK_PRECEDENCE = /^(bulk|list|junk)$/i;

type Json = Record<string, unknown>;

const obj = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
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

/** The bare addresses in a header such as `Ana <ana@x.io>, bo@y.io`. */
export function addressesIn(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/[^\s<>,;"']+@[^\s<>,;"']+/g)].map((match) => match[0].toLowerCase());
}

function excerpt(text: string | undefined): string | undefined {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > EXCERPT_CHARS ? `${trimmed.slice(0, EXCERPT_CHARS)}…` : trimmed;
}

/**
 * The alert a new mail makes for the guardian whose mailbox is `address`, or
 * null when it is bulk, automated, filed away by Gmail, or the guardian's own.
 * Mail where the guardian is only in cc still alerts, marked as such.
 */
export function gmailAlertOf(payload: Json, address: string): AlertEvent | null {
  const me = address.toLowerCase();
  const head = headers(payload);
  const labels = field(payload, "label_ids", "labelIds");
  const labelIds = Array.isArray(labels)
    ? labels.filter((l): l is string => typeof l === "string")
    : [];
  if (labelIds.length > 0 && !labelIds.includes("INBOX")) return null;
  if (labelIds.some((label) => SKIPPED_LABELS.has(label))) return null;

  const from = str(field(payload, "sender", "from")) ?? head.get("from");
  const [sender] = addressesIn(from);
  if (!sender || sender === me || AUTOMATED_SENDER.test(sender)) return null;
  if (head.has("list-unsubscribe") || head.has("list-id")) return null;
  if (BULK_PRECEDENCE.test(head.get("precedence")?.trim() ?? "")) return null;

  const to = addressesIn(str(field(payload, "to", "to")) ?? head.get("to"));
  const cc = addressesIn(head.get("cc") ?? str(field(payload, "cc", "cc")));
  const recipient = to.includes(me) ? "to" : cc.includes(me) ? "cc" : "other";

  const id = str(field(payload, "message_id", "messageId"));
  if (!id) return null;
  const thread = str(field(payload, "thread_id", "threadId"));
  const preview = obj(payload.preview);
  const subject = str(payload.subject) ?? str(preview.subject) ?? head.get("subject");
  const body = str(preview.body) ?? str(field(payload, "message_text", "messageText"));
  const quoted = excerpt(body);
  const fields: Record<string, string> = { mailbox: address, from: from ?? sender, recipient };
  if (subject) fields.subject = subject;
  if (thread) fields.url = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(thread)}`;
  return {
    id: `gmail:${me}:${id}`,
    source: "gmail",
    kind: "new_mail",
    fields,
    ...(quoted ? { text: quoted } : {}),
  };
}

/** Runs a connector action as the Concierge. */
export type RunConnectorAction = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ status: string; data?: unknown; error?: string }>;

const failure = (name: string, result: { status: string; error?: string }) =>
  result.error ?? `${name} returned ${result.status}`;

/** The guardian's Gmail account as the connector reaches it. */
export function gmailConnector(run: RunConnectorAction) {
  return {
    /** Arms the new-mail trigger. The connector treats a second call as a no-op. */
    async subscribe(): Promise<{ ok: true } | { ok: false; error: string }> {
      const result = await run("connector_event_subscribe", {
        toolkit: "gmail",
        slug: GMAIL_TRIGGER_SLUG,
        config: GMAIL_TRIGGER_CONFIG,
      });
      return result.status === "ok"
        ? { ok: true }
        : { ok: false, error: failure("connector_event_subscribe", result) };
    },
    /** The connected mailbox's address, from Gmail's profile. */
    async address(): Promise<string> {
      const result = await run("connector_proxy", {
        toolkit: "gmail",
        method: "GET",
        path: "/gmail/v1/users/me/profile",
      });
      if (result.status !== "ok") throw new Error(failure("connector_proxy", result));
      const address = str(obj(obj(result.data).data).emailAddress);
      if (!address) throw new Error("Gmail's profile carried no address");
      return address;
    },
  };
}
