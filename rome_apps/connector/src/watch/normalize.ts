// Turning a raw event from a watched source into the common shape a follower
// reads: the kind it is, who did it, a link, a short excerpt, and plain facts
// (from a bot, about the guardian, sent to them or in cc). Whether it matters is
// not decided here: the Concierge's triage reads the facts. Only spam, trash and
// events of a kind the follow does not have on are dropped. Each event's id is
// stable, so its follower drops a repeat delivery.

import { excerptOf, subjectOf } from "./text.js";

/** An event as a follower reads it. Every text field came from outside Rome. */
export interface WatchEvent {
  /** Stable identity, so a repeat delivery is dropped. */
  id: string;
  source: string;
  kind: string;
  actor?: string;
  subject?: string;
  url?: string;
  excerpt?: string;
  /** Plain facts with plain-name keys, such as `recipient: "cc"`, `bot: true`, `repo`. */
  facts: Record<string, string | number | boolean>;
}

export type Normalized = { keep: true; event: WatchEvent } | { keep: false; reason: string };

type Json = Record<string, unknown>;
type Facts = Record<string, string | number | boolean | undefined>;

const obj = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : undefined;
const loginOf = (user: unknown) => str(obj(user).login);
const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
const drop = (reason: string): Normalized => ({ keep: false, reason });

/** The facts that have a value. */
function facts(record: Facts): WatchEvent["facts"] {
  const out: WatchEvent["facts"] = {};
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value;
  return out;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GithubContext {
  /** The guardian's GitHub login. */
  login: string;
  /** The kinds the follow has on. */
  kinds: ReadonlySet<string>;
  /** Whether the guardian belongs to a team, for a review requested of a team. */
  isTeamMember(org: string, teamSlug: string): Promise<boolean>;
}

function mentions(text: string | undefined, login: string): boolean {
  if (!text) return false;
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])@${escaped}(?![\\w-])`, "i").test(text);
}

/** A GitHub delivery of `type` in the common shape, or why it is not one. */
export async function normalizeGithub(
  type: string,
  payload: Json,
  ctx: GithubContext,
): Promise<Normalized> {
  const { login } = ctx;
  const repository = obj(payload.repository);
  const repo = str(repository.full_name) ?? "";
  const sender = obj(payload.sender);
  const actor = str(sender.login);
  const bot = str(sender.type) === "Bot" || /\[bot\]$/i.test(actor ?? "");

  const event = (
    kind: string,
    id: string,
    fields: { subject?: string; url?: string; text?: string; facts?: Facts },
  ): Normalized => {
    if (!ctx.kinds.has(kind)) return drop("not a kind this follow has on");
    const quoted = excerptOf(fields.text);
    const subject = subjectOf(fields.subject);
    return {
      keep: true,
      event: {
        id: `github:${repo}:${id}`,
        source: "github",
        kind,
        ...(actor ? { actor } : {}),
        ...(subject ? { subject } : {}),
        ...(fields.url ? { url: fields.url } : {}),
        ...(quoted ? { excerpt: quoted } : {}),
        facts: facts({ repo, bot, byYou: same(actor, login), ...fields.facts }),
      },
    };
  };

  switch (type) {
    case "pull_request":
    case "issues": {
      const item = obj(type === "pull_request" ? payload.pull_request : payload.issue);
      const number = str(item.number);
      const on = type === "pull_request" ? "pull_request" : "issue";
      const author = loginOf(item.user);
      const shared = { subject: str(item.title), url: str(item.html_url) };
      const base = { number, on, author, yours: same(author, login) };
      if (type === "pull_request" && payload.action === "review_requested") {
        const reviewer = loginOf(payload.requested_reviewer);
        const team = str(obj(payload.requested_team).slug);
        const org = str(obj(payload.organization).login) ?? repo.split("/")[0] ?? "";
        const ofYou =
          same(reviewer, login) || (team !== undefined && (await ctx.isTeamMember(org, team)));
        return event("review_requested", `pr:${number}:review_requested:${reviewer ?? team}`, {
          ...shared,
          facts: { ...base, reviewer, team, aboutYou: ofYou },
        });
      }
      if (type === "pull_request" && payload.action === "closed") {
        return event("your_pr_closed", `pr:${number}:closed`, {
          ...shared,
          facts: { ...base, outcome: item.merged === true ? "merged" : "closed" },
        });
      }
      if (payload.action === "assigned") {
        const assignee = loginOf(payload.assignee);
        return event("assigned_to_you", `${on}:${number}:assigned:${assignee}`, {
          ...shared,
          facts: { ...base, assignee, aboutYou: same(assignee, login) },
        });
      }
      if (payload.action === "opened") {
        return event("new_pr_or_issue", `${on}:${number}:opened`, {
          ...shared,
          text: str(item.body),
          facts: base,
        });
      }
      return drop(`GitHub ${type}.${String(payload.action)} is not a kind follows describe`);
    }
    case "pull_request_review": {
      if (payload.action !== "submitted") return drop("not a submitted review");
      const pr = obj(payload.pull_request);
      const review = obj(payload.review);
      const author = loginOf(pr.user);
      return event("review_on_your_pr", `review:${str(review.id)}`, {
        subject: str(pr.title),
        url: str(review.html_url) ?? str(pr.html_url),
        text: str(review.body),
        facts: {
          number: str(pr.number),
          on: "pull_request",
          author,
          yours: same(author, login),
          state: str(review.state)?.toLowerCase() ?? "commented",
        },
      });
    }
    case "issue_comment":
    case "pull_request_review_comment": {
      if (payload.action !== "created") return drop("not a new comment");
      const comment = obj(payload.comment);
      const body = str(comment.body);
      const thread = type === "issue_comment" ? obj(payload.issue) : obj(payload.pull_request);
      const author = loginOf(thread.user);
      const isPr = type === "pull_request_review_comment" || "pull_request" in thread;
      return event("comment_or_mention", `comment:${str(comment.id)}`, {
        subject: str(thread.title),
        url: str(comment.html_url),
        text: body,
        facts: {
          number: str(thread.number),
          on: isPr ? "pull_request" : "issue",
          author,
          yours: same(author, login),
          mentionsYou: mentions(body, login),
        },
      });
    }
    case "workflow_run": {
      const run = obj(payload.workflow_run);
      if (payload.action !== "completed" || run.conclusion !== "failure") {
        return drop("not a failed run");
      }
      const branch = str(run.head_branch);
      const prs = Array.isArray(run.pull_requests) ? run.pull_requests.map(obj) : [];
      return event("your_ci_failed", `run:${str(run.id)}:${str(run.run_attempt) ?? "1"}`, {
        subject: str(run.display_title) ?? str(run.name),
        url: str(run.html_url),
        facts: {
          workflow: str(run.name),
          branch,
          pr:
            prs
              .map((pr) => str(pr.number))
              .filter(Boolean)
              .join(",") || undefined,
          triggeredByYou:
            same(loginOf(run.triggering_actor), login) || same(loginOf(run.actor), login),
          onDefaultBranch: branch !== undefined && same(branch, str(repository.default_branch)),
        },
      });
    }
    default:
      return drop(`GitHub ${type} is not a kind follows describe`);
  }
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

const DROPPED_LABELS = ["SPAM", "TRASH"];
/** Gmail's tabs, as the fact `category`. */
const CATEGORIES: Record<string, string> = {
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_FORUMS: "forums",
  CATEGORY_UPDATES: "updates",
  CATEGORY_PERSONAL: "primary",
};
/**
 * Senders no person answers from: a no-reply, notification, bounce or
 * mailer token anywhere in the address's local part, as a whole token between
 * `.`, `_`, `+` or `-` (`jobalerts-noreply@`, `noreply.billing@`), so a name
 * that only contains those letters (`noriko@`, `bouncer.lee@`) is a person.
 */
export function isAutomatedSender(address: string): boolean {
  const local = address.split("@")[0]?.toLowerCase() ?? "";
  return /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?)($|[._+-])/.test(
    local,
  );
}
const BULK_PRECEDENCE = /^(bulk|list|junk)$/i;

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

/** The bare addresses in a header such as `Ana <ana@x.io>, bo@y.io`, lower-cased. */
export function addressesIn(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/[^\s<>,;"']+@[^\s<>,;"']+/g)].map((match) => match[0].toLowerCase());
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
  const category = labelIds.map((label) => CATEGORIES[label]).find(Boolean);
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
      facts: facts({
        mailbox: me,
        recipient: to.includes(me) ? "to" : cc.includes(me) ? "cc" : "other",
        byYou: sender === me,
        category,
        inInbox: labelIds.length === 0 ? undefined : labelIds.includes("INBOX"),
        automatedSender: sender ? isAutomatedSender(sender) : undefined,
        listMail: head.has("list-unsubscribe") || head.has("list-id") || undefined,
        bulk: BULK_PRECEDENCE.test(head.get("precedence")?.trim() ?? "") || undefined,
      }),
    },
  };
}
