// Turning a raw event from a watched source into what a follower hears: one
// common shape, or a reason it is dropped. The checks run here, in code, so
// bulk, automated and unrelated events never reach a model.

import { GITHUB_WATCHABLE, GMAIL_WATCHABLE, optionValue } from "./catalog.js";

const EXCERPT_CHARS = 300;

/** An event a follower hears of. Every text field came from outside Rome. */
export interface WatchEvent {
  /** Stable identity, so a redelivery is dropped. */
  id: string;
  source: string;
  kind: string;
  actor?: string;
  subject?: string;
  url?: string;
  excerpt?: string;
  /** Short judged facts, such as `recipient: cc` or `bot: true`. */
  facts: Record<string, string | boolean>;
  /** Short source details, such as the repo or the PR number. */
  details: Record<string, string>;
}

export type Judgement = { relevant: true; event: WatchEvent } | { relevant: false; reason: string };

type Json = Record<string, unknown>;

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
const drop = (reason: string): Judgement => ({ relevant: false, reason });

function excerpt(text: string | undefined): string | undefined {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > EXCERPT_CHARS ? `${trimmed.slice(0, EXCERPT_CHARS)}…` : trimmed;
}

function compact(record: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) if (value) out[key] = value;
  return out;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GithubJudgeContext {
  /** The guardian's GitHub login. */
  login: string;
  /** The kinds the follow has on. */
  kinds: ReadonlySet<string>;
  options?: Record<string, unknown>;
  /** Whether the guardian belongs to a team, for a review requested of the team. */
  isTeamMember(org: string, teamSlug: string): Promise<boolean>;
}

function mentions(text: string | undefined, login: string): boolean {
  if (!text) return false;
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])@${escaped}(?![\\w-])`, "i").test(text);
}

/** The event a GitHub delivery of `type` makes for the guardian, or why it does not. */
export async function judgeGithub(
  type: string,
  payload: Json,
  ctx: GithubJudgeContext,
): Promise<Judgement> {
  const { login, kinds } = ctx;
  const option = (key: string) => optionValue(GITHUB_WATCHABLE, ctx.options, key);
  const wholeRepo = option("scope") === "whole_repo";
  const on = (kind: string) => {
    if (!kinds.has(kind)) return false;
    const requires = GITHUB_WATCHABLE.kinds.find((k) => k.kind === kind)?.requires;
    return !requires || option(requires.option) === requires.value;
  };
  const repository = obj(payload.repository);
  const repo = str(repository.full_name) ?? "";
  const sender = obj(payload.sender);
  const actor = str(sender.login);
  const bot = str(sender.type) === "Bot" || /\[bot\]$/i.test(actor ?? "");

  // People rules hold for every kind; the guardian's own push still counts below.
  if (bot && option("includeBots") !== true) return drop("from a bot");
  const ignore = option("ignorePeople") as string[];
  const only = option("onlyPeople") as string[];
  const named = (list: string[]) =>
    list.some(
      (person) =>
        same(person.replace(/^@/, ""), actor) || same(person, actor?.replace(/\[bot\]$/i, "")),
    );
  if (actor && named(ignore)) return drop("from an ignored person");

  const event = (
    kind: string,
    id: string,
    fields: {
      subject?: string;
      url?: string;
      text?: string;
      facts?: Record<string, string | boolean>;
      details?: Record<string, string | undefined>;
    },
  ): Judgement => {
    // The guardian's own failed run is theirs to hear about, whoever else the follow names.
    if (only.length > 0 && !named(only) && !same(actor, login)) {
      return drop("not from a person the follow names");
    }
    const quoted = excerpt(fields.text);
    return {
      relevant: true,
      event: {
        id: `github:${repo}:${id}`,
        source: "github",
        kind,
        ...(actor ? { actor } : {}),
        ...(fields.subject ? { subject: fields.subject } : {}),
        ...(fields.url ? { url: fields.url } : {}),
        ...(quoted ? { excerpt: quoted } : {}),
        facts: { ...(bot ? { bot: true } : {}), ...fields.facts },
        details: compact({ repo, ...fields.details }),
      },
    };
  };

  // The guardian's own requests, reviews, comments and closes are no news to
  // them. A failed run they triggered is: the sender of `workflow_run` is the
  // one who pushed.
  if (type !== "workflow_run" && same(actor, login)) return drop("the guardian's own action");

  switch (type) {
    case "pull_request":
    case "issues": {
      const item = obj(type === "pull_request" ? payload.pull_request : payload.issue);
      const number = str(item.number);
      const what = type === "pull_request" ? "pull_request" : "issue";
      const shared = {
        subject: str(item.title),
        url: str(item.html_url),
        details: { number, on: what, author: loginOf(item.user) },
      };
      if (
        type === "pull_request" &&
        payload.action === "review_requested" &&
        on("review_requested")
      ) {
        if (same(loginOf(payload.requested_reviewer), login)) {
          return event("review_requested", `pr:${number}:review_requested:${login}`, {
            ...shared,
            facts: { aboutMe: true },
          });
        }
        const team = obj(payload.requested_team);
        const org = str(obj(payload.organization).login) ?? repo.split("/")[0] ?? "";
        const slug = str(team.slug);
        if (slug && org && (await ctx.isTeamMember(org, slug))) {
          return event("review_requested", `pr:${number}:review_requested:team:${slug}`, {
            ...shared,
            facts: { aboutMe: true, team: slug },
          });
        }
        return drop("a review requested of someone else");
      }
      if (type === "pull_request" && payload.action === "closed" && on("your_pr_closed")) {
        if (!same(loginOf(item.user), login)) return drop("someone else's pull request");
        const merged = item.merged === true;
        return event("your_pr_closed", `pr:${number}:closed`, {
          ...shared,
          facts: { aboutMe: true, outcome: merged ? "merged" : "closed" },
        });
      }
      if (payload.action === "assigned" && on("assigned_to_you")) {
        if (!same(loginOf(payload.assignee), login)) return drop("assigned to someone else");
        return event("assigned_to_you", `${what}:${number}:assigned:${login}`, {
          ...shared,
          facts: { aboutMe: true },
        });
      }
      if (payload.action === "opened" && on("new_pr_or_issue") && wholeRepo) {
        return event("new_pr_or_issue", `${what}:${number}:opened`, {
          ...shared,
          text: str(item.body),
        });
      }
      return drop("not a kind the follow has on");
    }
    case "pull_request_review": {
      if (payload.action !== "submitted" || !on("review_on_your_pr")) {
        return drop("not a kind the follow has on");
      }
      const pr = obj(payload.pull_request);
      if (!same(loginOf(pr.user), login)) return drop("someone else's pull request");
      const review = obj(payload.review);
      return event("review_on_your_pr", `review:${str(review.id)}`, {
        subject: str(pr.title),
        url: str(review.html_url) ?? str(pr.html_url),
        text: str(review.body),
        facts: { aboutMe: true, state: str(review.state)?.toLowerCase() ?? "commented" },
        details: { number: str(pr.number), on: "pull_request" },
      });
    }
    case "issue_comment":
    case "pull_request_review_comment": {
      if (payload.action !== "created" || !on("comment_or_mention")) {
        return drop("not a kind the follow has on");
      }
      const comment = obj(payload.comment);
      const body = str(comment.body);
      const thread = type === "issue_comment" ? obj(payload.issue) : obj(payload.pull_request);
      const theirs = same(loginOf(thread.user), login);
      const mentioned = mentions(body, login);
      if (!theirs && !mentioned) return drop("neither the guardian's thread nor a mention");
      const isPr = type === "pull_request_review_comment" || "pull_request" in thread;
      return event("comment_or_mention", `comment:${str(comment.id)}`, {
        subject: str(thread.title),
        url: str(comment.html_url),
        text: body,
        facts: { aboutMe: true, mention: mentioned },
        details: { number: str(thread.number), on: isPr ? "pull_request" : "issue" },
      });
    }
    case "workflow_run": {
      const run = obj(payload.workflow_run);
      if (payload.action !== "completed" || run.conclusion !== "failure") {
        return drop("not a failed run");
      }
      const mine = same(loginOf(run.triggering_actor), login) || same(loginOf(run.actor), login);
      const branch = str(run.head_branch);
      const onDefault = branch !== undefined && same(branch, str(repository.default_branch));
      const prs = Array.isArray(run.pull_requests) ? run.pull_requests.map(obj) : [];
      const shared = {
        subject: str(run.display_title) ?? str(run.name),
        url: str(run.html_url),
        details: {
          workflow: str(run.name),
          branch,
          pr:
            prs
              .map((pr) => str(pr.number))
              .filter(Boolean)
              .join(",") || undefined,
        },
      };
      const id = `run:${str(run.id)}:${str(run.run_attempt) ?? "1"}`;
      if (mine && on("your_ci_failed")) {
        return event("your_ci_failed", id, { ...shared, facts: { aboutMe: true } });
      }
      if (onDefault && on("default_branch_ci_failed")) {
        return event("default_branch_ci_failed", id, { ...shared, facts: { aboutMe: mine } });
      }
      return drop(mine ? "not a kind the follow has on" : "someone else's run");
    }
    default:
      return drop(`GitHub ${type} events are not followed`);
  }
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

/** Gmail's own sorting: mail it filed as promotions or the like is not personal. */
const SKIPPED_LABELS = [
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
  "SPAM",
  "TRASH",
];
const UPDATES_LABEL = "CATEGORY_UPDATES";
/** Senders no person answers from. */
const AUTOMATED_SENDER =
  /^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?)([+._-][^@]*)?@/i;
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

export interface GmailJudgeContext {
  /** The connected mailbox's address. */
  address: string;
  options?: Record<string, unknown>;
}

const isVip = (sender: string, vips: string[]) =>
  vips.some((vip) => {
    const v = vip.trim().toLowerCase().replace(/^@/, "");
    return v.includes("@") ? sender === v : sender.endsWith(`@${v}`) || sender.endsWith(`.${v}`);
  });

/** The event a new Gmail message makes for the guardian, or why it does not. */
export function judgeGmail(payload: Json, ctx: GmailJudgeContext): Judgement {
  const me = ctx.address.toLowerCase();
  const option = (key: string) => optionValue(GMAIL_WATCHABLE, ctx.options, key);
  const head = headers(payload);
  const labels = field(payload, "label_ids", "labelIds");
  const labelIds = Array.isArray(labels)
    ? labels.filter((l): l is string => typeof l === "string")
    : [];
  if (labelIds.length > 0 && !labelIds.includes("INBOX")) return drop("not in the inbox");

  const from = str(field(payload, "sender", "from")) ?? head.get("from");
  const [sender] = addressesIn(from);
  if (!sender) return drop("no sender");
  if (sender === me) return drop("the guardian's own mail");
  const vip = isVip(sender, option("vipSenders") as string[]);
  if (!vip) {
    if (labelIds.some((label) => SKIPPED_LABELS.includes(label)))
      return drop("filed away by Gmail");
    if (labelIds.includes(UPDATES_LABEL) && option("includeUpdates") !== true) {
      return drop("in Gmail's Updates tab");
    }
    if (AUTOMATED_SENDER.test(sender)) return drop("from an automated sender");
    if (head.has("list-unsubscribe") || head.has("list-id")) return drop("list mail");
    if (BULK_PRECEDENCE.test(head.get("precedence")?.trim() ?? "")) return drop("bulk mail");
  }

  const to = addressesIn(str(field(payload, "to", "to")) ?? head.get("to"));
  const cc = addressesIn(head.get("cc") ?? str(field(payload, "cc", "cc")));
  const recipient = to.includes(me) ? "to" : cc.includes(me) ? "cc" : "other";
  if (!vip && option("recipients") === "to" && recipient !== "to") {
    return drop("not sent to the guardian directly");
  }

  const id = str(field(payload, "message_id", "messageId"));
  if (!id) return drop("no message id");
  const thread = str(field(payload, "thread_id", "threadId"));
  const preview = obj(payload.preview);
  const subject = str(payload.subject) ?? str(preview.subject) ?? head.get("subject");
  const quoted = excerpt(str(preview.body) ?? str(field(payload, "message_text", "messageText")));
  return {
    relevant: true,
    event: {
      id: `gmail:${me}:${id}`,
      source: "gmail",
      kind: "new_mail",
      actor: from ?? sender,
      ...(subject ? { subject } : {}),
      ...(thread
        ? { url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(thread)}` }
        : {}),
      ...(quoted ? { excerpt: quoted } : {}),
      facts: { recipient, ...(vip ? { vip: true } : {}) },
      details: { mailbox: me },
    },
  };
}
