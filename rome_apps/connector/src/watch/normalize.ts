// Turning a raw event from a watched source into the common shape a follower
// reads: the kind it is, who did it, a link, a short excerpt, whether the
// guardian did it, how it is addressed to them, and labels, short words this
// connection chooses for what else it knows (a bot, a mailing list, a failed
// run). Whether it matters is not decided here. Only spam, trash and events of
// a kind the follow does not have on are dropped. Each event's id is stable,
// so its follower drops a repeat delivery.

import { excerptOf, subjectOf } from "./text.js";

/**
 * How an event is addressed to the guardian: `direct` when it is theirs or
 * asks them (sent To them, a review requested of them, their own pull
 * request), `copy` when they are copied, `other` otherwise.
 */
export type AddressedTo = "direct" | "copy" | "other";

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
  /** The guardian did it. */
  byYou: boolean;
  addressedTo: AddressedTo;
  /** What else the connection knows, in short lowercase words. */
  labels: string[];
}

export type Normalized = { keep: true; event: WatchEvent } | { keep: false; reason: string };

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
const drop = (reason: string): Normalized => ({ keep: false, reason });

/** The labels that apply, each once. */
const labelsOf = (...labels: (string | false | undefined)[]): string[] => [
  ...new Set(labels.filter((label): label is string => Boolean(label))),
];

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
    fields: {
      subject?: string;
      url?: string;
      text?: string;
      addressedTo: AddressedTo;
      byYou?: boolean;
      labels: (string | false | undefined)[];
    },
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
        byYou: fields.byYou ?? same(actor, login),
        addressedTo: fields.addressedTo,
        labels: labelsOf(bot && "bot", ...fields.labels),
      },
    };
  };

  switch (type) {
    case "pull_request":
    case "issues": {
      const item = obj(type === "pull_request" ? payload.pull_request : payload.issue);
      const number = str(item.number);
      const on = type === "pull_request" ? "pull-request" : "issue";
      const yours = same(loginOf(item.user), login);
      const shared = { subject: str(item.title), url: str(item.html_url) };
      // One pull request or issue sees the same action again (a second review
      // request, a close after a reopen, a re-assign). Its `updated_at` tells
      // those apart, and stays the same when GitHub redelivers one webhook.
      const at = str(item.updated_at);
      const when = at ? `:${at}` : "";
      if (type === "pull_request" && payload.action === "review_requested") {
        const reviewer = loginOf(payload.requested_reviewer);
        const team = str(obj(payload.requested_team).slug);
        const org = str(obj(payload.organization).login) ?? repo.split("/")[0] ?? "";
        const ofYou =
          same(reviewer, login) || (team !== undefined && (await ctx.isTeamMember(org, team)));
        return event(
          "review_requested",
          `pr:${number}:review_requested:${reviewer ?? team}${when}`,
          {
            ...shared,
            addressedTo: ofYou || yours ? "direct" : "other",
            labels: [on, "review-requested", team && "team-review"],
          },
        );
      }
      if (type === "pull_request" && payload.action === "closed") {
        return event("your_pr_closed", `pr:${number}:closed${when}`, {
          ...shared,
          addressedTo: yours ? "direct" : "other",
          labels: [on, item.merged === true ? "merged" : "closed"],
        });
      }
      if (payload.action === "assigned") {
        const toYou = same(loginOf(payload.assignee), login);
        return event(
          "assigned_to_you",
          `${on}:${number}:assigned:${loginOf(payload.assignee)}${when}`,
          {
            ...shared,
            addressedTo: toYou ? "direct" : "other",
            labels: [on, "assigned"],
          },
        );
      }
      if (payload.action === "opened") {
        return event("new_pr_or_issue", `${on}:${number}:opened`, {
          ...shared,
          text: str(item.body),
          addressedTo: mentions(str(item.body), login) ? "direct" : "other",
          labels: [on, "opened"],
        });
      }
      return drop(`GitHub ${type}.${String(payload.action)} is not a kind follows describe`);
    }
    case "pull_request_review": {
      if (payload.action !== "submitted") return drop("not a submitted review");
      const pr = obj(payload.pull_request);
      const review = obj(payload.review);
      const state = str(review.state)?.toLowerCase().replaceAll("_", "-") ?? "commented";
      return event("review_on_your_pr", `review:${str(review.id)}`, {
        subject: str(pr.title),
        url: str(review.html_url) ?? str(pr.html_url),
        text: str(review.body),
        addressedTo: same(loginOf(pr.user), login) ? "direct" : "other",
        labels: ["pull-request", "review", state],
      });
    }
    case "issue_comment":
    case "pull_request_review_comment": {
      if (payload.action !== "created") return drop("not a new comment");
      const comment = obj(payload.comment);
      const body = str(comment.body);
      const thread = type === "issue_comment" ? obj(payload.issue) : obj(payload.pull_request);
      const isPr = type === "pull_request_review_comment" || "pull_request" in thread;
      const mentioned = mentions(body, login);
      return event("comment_or_mention", `comment:${str(comment.id)}`, {
        subject: str(thread.title),
        url: str(comment.html_url),
        text: body,
        addressedTo: mentioned || same(loginOf(thread.user), login) ? "direct" : "other",
        labels: [isPr ? "pull-request" : "issue", "comment", mentioned && "mention"],
      });
    }
    case "workflow_run": {
      const run = obj(payload.workflow_run);
      if (payload.action !== "completed" || run.conclusion !== "failure") {
        return drop("not a failed run");
      }
      const branch = str(run.head_branch);
      const triggeredByYou =
        same(loginOf(run.triggering_actor), login) || same(loginOf(run.actor), login);
      const prs = Array.isArray(run.pull_requests) ? run.pull_requests.map(obj) : [];
      return event("your_ci_failed", `run:${str(run.id)}:${str(run.run_attempt) ?? "1"}`, {
        subject: str(run.display_title) ?? str(run.name),
        url: str(run.html_url),
        byYou: triggeredByYou,
        addressedTo: triggeredByYou ? "direct" : "other",
        labels: [
          "ci-failed",
          branch !== undefined && same(branch, str(repository.default_branch)) && "default-branch",
          prs.length > 0 && "pull-request",
        ],
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
/** Gmail's tabs, as labels. */
const CATEGORIES: Record<string, string> = {
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_FORUMS: "forums",
  CATEGORY_UPDATES: "updates",
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

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

export interface CalendarContext {
  /** The connected account's address, which is its primary calendar's id. */
  address: string;
  /** The kinds the follow has on. */
  kinds: ReadonlySet<string>;
}

interface Attendee {
  email?: string;
  self: boolean;
  organizer: boolean;
  optional: boolean;
  resource: boolean;
  response?: string;
}

/** Google's attendee objects, or bare addresses when Composio flattens them. */
function attendeesOf(value: unknown): Attendee[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const a = typeof item === "string" ? { email: item } : obj(item);
    return {
      email: str(a.email)?.toLowerCase(),
      self: a.self === true,
      organizer: a.organizer === true,
      optional: a.optional === true,
      resource: a.resource === true,
      response: str(a.responseStatus ?? a.response_status),
    };
  });
}

const ISO_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * When an event runs, in the time zone the event carries: `2026-11-04 15:00–16:00
 * (+08:00)`, or `2026-11-04, all day`. The common shape has no time field, so
 * the time reads as text in the excerpt.
 */
export function whenOf(start: string | undefined, end: string | undefined): string | undefined {
  if (!start) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return `${start}, all day`;
  const from = ISO_TIME.exec(start);
  if (!from) return start;
  const [, day, time, zone] = from;
  const to = end ? ISO_TIME.exec(end) : null;
  const until = to ? (to[1] === day ? `–${to[2]}` : ` – ${to[1]} ${to[2]}`) : "";
  const tz = zone === undefined ? "" : zone === "Z" ? " (UTC)" : ` (${zone})`;
  return `${day} ${time}${until}${tz}`;
}

/** Sentences joined into one excerpt, each ending in its own stop. */
const sentences = (...parts: (string | undefined)[]) =>
  parts
    .filter((part): part is string => Boolean(part))
    .map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`))
    .join(" ");

/** A raw Calendar event of `type` in the common shape, or why it is not one. */
export function normalizeCalendar(type: string, payload: Json, ctx: CalendarContext): Normalized {
  const me = ctx.address.toLowerCase();
  const eventId = str(payload.event_id);
  if (!eventId) return drop("no event id");
  const event = (
    kind: string,
    id: string,
    fields: Omit<WatchEvent, "id" | "source" | "kind" | "labels"> & {
      labels: (string | false | undefined)[];
    },
  ): Normalized => {
    if (!ctx.kinds.has(kind)) return drop("not a kind this follow has on");
    const subject = subjectOf(fields.subject);
    const excerpt = excerptOf(fields.excerpt);
    return {
      keep: true,
      event: {
        id: `googlecalendar:${me}:${eventId}:${id}`,
        source: "googlecalendar",
        kind,
        ...(fields.actor ? { actor: fields.actor } : {}),
        ...(subject ? { subject } : {}),
        ...(fields.url ? { url: fields.url } : {}),
        ...(excerpt ? { excerpt } : {}),
        byYou: fields.byYou,
        addressedTo: fields.addressedTo,
        labels: labelsOf(...fields.labels),
      },
    };
  };

  // What the starting-soon and sync payloads share: the organizer, the
  // attendees, and the guardian's place among them.
  const attendees = attendeesOf(payload.attendees);
  const mine = attendees.find((a) => a.self || a.email === me);
  const organizer = str(payload.organizer_email)?.toLowerCase();
  const organizedByYou =
    (organizer !== undefined ? organizer === me : false) || mine?.organizer === true;
  const guests = attendees.filter((a) => !a.resource && a !== mine && a.email !== me);
  const addressedTo: AddressedTo =
    organizedByYou || (mine !== undefined && !mine.optional)
      ? "direct"
      : mine?.optional
        ? "copy"
        : attendees.length === 0 && (organizer === undefined || organizer === me)
          ? "direct"
          : "other";
  const meeting = {
    actor: str(payload.organizer_name) ?? organizer,
    subject: str(payload.summary),
    addressedTo,
  };
  const shared = [
    organizedByYou && "organizer",
    guests.length === 0 && "no-guests",
    str(payload.recurring_event_id) && "recurring",
    (str(payload.hangout_link) || Object.keys(obj(payload.conference_data)).length > 0) && "online",
    mine?.response === "needsAction" && "needs-reply",
    mine?.response === "declined" && "you-declined",
    mine?.response === "tentative" && "you-tentative",
  ];
  const where = str(payload.location) && `At ${str(payload.location)}`;

  switch (type) {
    case "googlecalendar_event_starting_soon_trigger": {
      const start = str(payload.start_time);
      const left =
        typeof payload.minutes_until_start === "number" ? payload.minutes_until_start : undefined;
      const inMinutes =
        left === undefined ? undefined : `in ${Math.max(0, Math.round(left))} minutes`;
      return event(
        "meeting_starting_soon",
        `starting:${str(payload.start_timestamp) ?? start ?? ""}`,
        {
          ...meeting,
          // The join link is what the guardian needs a few minutes ahead.
          url: str(payload.hangout_link) ?? str(payload.html_link),
          excerpt: sentences(
            [whenOf(start, undefined) && `Starts ${whenOf(start, undefined)}`, inMinutes]
              .filter(Boolean)
              .join(", ") || undefined,
            where,
            str(payload.description),
          ),
          byYou: false,
          labels: ["starting-soon", ...shared],
        },
      );
    }
    case "googlecalendar_google_calendar_event_sync_trigger": {
      const change = str(payload.event_type)?.toLowerCase();
      const canceled = change === "deleted" || str(payload.status)?.toLowerCase() === "cancelled";
      const created = change === "created" && !canceled;
      const createdByYou = str(payload.creator_email)?.toLowerCase() === me;
      const what = canceled
        ? "canceled"
        : created
          ? mine && !organizedByYou && !createdByYou
            ? "invite"
            : "created"
          : "updated";
      return event(
        "invitations_and_changes",
        `${what}:${str(payload.updated_at) ?? str(payload.created_at) ?? ""}`,
        {
          ...meeting,
          url: str(payload.html_link),
          excerpt: sentences(
            whenOf(str(payload.start_time), str(payload.end_time)),
            where,
            str(payload.description),
          ),
          // Only the organizer or the creator changes an event, so either one
          // being the guardian means the guardian did it.
          byYou: organizedByYou || createdByYou,
          labels: [what, ...shared],
        },
      );
    }
    case "googlecalendar_attendee_response_changed_trigger": {
      const who = str(payload.attendee_email)?.toLowerCase();
      const response = str(payload.response_status)?.toLowerCase();
      const name = str(payload.attendee_name) ?? who;
      const before = str(payload.previous_response_status)?.toLowerCase();
      return event("rsvp_changes", `rsvp:${who ?? ""}:${before ?? ""}:${response ?? ""}`, {
        actor: name,
        subject: str(payload.event_summary),
        url: str(payload.event_html_link),
        excerpt: name && response ? sentences(`${name} answered ${response}`) : undefined,
        byYou: who === me,
        // The payload names no organizer, so whether the event is the
        // guardian's own is not known here.
        addressedTo: "other",
        labels: ["rsvp", response && /^[a-z]+$/.test(response) && response],
      });
    }
    default:
      return drop(`Google Calendar ${type} is not a kind follows describe`);
  }
}
