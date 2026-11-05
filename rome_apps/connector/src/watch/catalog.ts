import { buildTopic } from "../api/topic.js";

// What this app's connections let Rome watch: per source, the kinds of event a
// follower may turn on, in words the guardian reads, the options that tune them,
// and the raw bus events behind each kind. Core reads it through the
// `connector_watch_sources` action and never names a source itself.

/**
 * One raw event a kind listens on, by the provider and event type this app
 * declares under `eventSources` in app.yaml; its bus name follows from them.
 * `{target}` in an `equals` is the followed target.
 */
export interface WatchTrigger {
  provider: string;
  type: string;
  filter?: { field: string; equals: string }[];
}

/** The bus name of a trigger's raw event. */
export const eventNameOf = (trigger: Pick<WatchTrigger, "provider" | "type">) =>
  buildTopic(trigger.provider, trigger.type);

export interface WatchKind {
  kind: string;
  label: string;
  /** On when the guardian follows something and names no kinds. */
  default: boolean;
  triggers: WatchTrigger[];
}

export interface WatchOption {
  key: string;
  label: string;
  type: "enum" | "boolean" | "list";
  /** The allowed values of an enum, with the words the guardian reads for each. */
  values?: { value: string; label: string }[];
  default: string | boolean | string[];
  /** What a list holds, such as GitHub logins. */
  itemHint?: string;
}

export interface Watchable {
  source: string;
  label: string;
  /** What a follow names at the source, or null: the connected account itself. */
  target: { format: string; example: string } | null;
  kinds: WatchKind[];
  options: WatchOption[];
}

const repo = (type: string): WatchTrigger => ({
  provider: "github",
  type,
  filter: [{ field: "repository.full_name", equals: "{target}" }],
});

export const GITHUB_WATCHABLE: Watchable = {
  source: "github",
  label: "GitHub",
  target: { format: "A repository as owner/name", example: "rome-os/rome" },
  // Each kind is a shape of event, whoever it concerns: whether it is about
  // the guardian is a fact on the event, read when it is triaged.
  kinds: [
    {
      kind: "review_requested",
      label: "Review requests",
      default: true,
      triggers: [repo("pull_request")],
    },
    {
      kind: "review_on_your_pr",
      label: "Reviews of pull requests",
      default: true,
      triggers: [repo("pull_request_review")],
    },
    {
      kind: "comment_or_mention",
      label: "Comments on pull requests and issues",
      default: true,
      triggers: [repo("issue_comment"), repo("pull_request_review_comment")],
    },
    {
      kind: "your_ci_failed",
      label: "Failed CI runs",
      default: true,
      triggers: [repo("workflow_run")],
    },
    {
      kind: "your_pr_closed",
      label: "Pull requests merged or closed",
      default: true,
      triggers: [repo("pull_request")],
    },
    {
      kind: "assigned_to_you",
      label: "Assignments",
      default: true,
      triggers: [repo("issues"), repo("pull_request")],
    },
    {
      kind: "new_pr_or_issue",
      label: "New pull requests and issues",
      default: false,
      triggers: [repo("issues"), repo("pull_request")],
    },
  ],
  // The guardian's explicit wishes, stored as structured values. A follower
  // renders them in words for its triage, as guidance, never as filters.
  options: [
    {
      key: "scope",
      label: "What to hear about",
      type: "enum",
      values: [
        { value: "about_me", label: "Only what concerns me" },
        { value: "whole_repo", label: "Also the whole repository" },
      ],
      default: "about_me",
    },
    {
      key: "ignorePeople",
      label: "Ignore these people",
      type: "list",
      default: [],
      itemHint: "GitHub logins",
    },
    {
      key: "onlyPeople",
      label: "Only these people",
      type: "list",
      default: [],
      itemHint: "GitHub logins; empty means everyone",
    },
    {
      key: "includeBots",
      label: "Include bots",
      type: "boolean",
      default: false,
    },
  ],
};

export const GMAIL_TRIGGER_SLUG = "GMAIL_NEW_GMAIL_MESSAGE";
/** The event type the trigger publishes, as `eventSources` declares it. */
export const GMAIL_NEW_MAIL_TYPE = GMAIL_TRIGGER_SLUG.toLowerCase();
/** The trigger watches the inbox only; Composio wants the label as a string. */
export const GMAIL_TRIGGER_CONFIG = { labelIds: "INBOX" };

export const GMAIL_WATCHABLE: Watchable = {
  source: "gmail",
  label: "Gmail",
  target: null,
  kinds: [
    {
      kind: "new_mail",
      label: "New mail",
      default: true,
      // One Gmail account is connected at a time, so the event needs no filter.
      triggers: [{ provider: "gmail", type: GMAIL_NEW_MAIL_TYPE }],
    },
  ],
  options: [
    {
      key: "recipients",
      label: "Mail sent to",
      type: "enum",
      values: [
        { value: "to_and_cc", label: "Me, or with me in cc" },
        { value: "to", label: "Me directly" },
      ],
      default: "to_and_cc",
    },
    {
      key: "vipSenders",
      label: "Always tell me about these senders",
      type: "list",
      default: [],
      itemHint: "Addresses or domains",
    },
  ],
};

/** A Composio trigger a kind listens on, with the config this app arms it with. */
export interface ComposioTriggerSpec {
  toolkit: string;
  slug: string;
  config: Record<string, unknown>;
}

export const CALENDAR_STARTING_SOON: ComposioTriggerSpec = {
  toolkit: "googlecalendar",
  slug: "GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER",
  // Composio fixes the lead time per trigger, and one calendar account is
  // connected at a time, so every follow hears ten minutes ahead.
  config: { calendarId: "primary", minutesBeforeStart: 10, includeAllDay: false },
};
/** Created, updated and deleted events with their attendees, which the narrower triggers lack. */
export const CALENDAR_EVENT_SYNC: ComposioTriggerSpec = {
  toolkit: "googlecalendar",
  slug: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER",
  config: { calendarId: "primary", showDeleted: true },
};
export const CALENDAR_RSVP: ComposioTriggerSpec = {
  toolkit: "googlecalendar",
  slug: "GOOGLECALENDAR_ATTENDEE_RESPONSE_CHANGED_TRIGGER",
  config: { calendarId: "primary" },
};

/** The trigger of a Composio spec, as a kind lists it. */
const fromComposio = (spec: ComposioTriggerSpec): WatchTrigger => ({
  provider: spec.toolkit,
  type: spec.slug.toLowerCase(),
});

export const CALENDAR_WATCHABLE: Watchable = {
  source: "googlecalendar",
  label: "Google Calendar",
  target: null,
  // The connected account's primary calendar, so no trigger needs a filter.
  kinds: [
    {
      kind: "meeting_starting_soon",
      label: "Meetings starting soon",
      default: true,
      triggers: [fromComposio(CALENDAR_STARTING_SOON)],
    },
    {
      kind: "invitations_and_changes",
      label: "Invitations and changes to my events",
      default: true,
      triggers: [fromComposio(CALENDAR_EVENT_SYNC)],
    },
    {
      kind: "rsvp_changes",
      label: "Replies to invitations",
      default: false,
      triggers: [fromComposio(CALENDAR_RSVP)],
    },
  ],
  options: [
    {
      key: "events",
      label: "Events to hear about",
      type: "enum",
      values: [
        { value: "with_others", label: "Only meetings with other people" },
        { value: "all", label: "Also my own events without guests" },
      ],
      default: "with_others",
    },
  ],
};

export const WATCHABLES: readonly Watchable[] = [
  GITHUB_WATCHABLE,
  GMAIL_WATCHABLE,
  CALENDAR_WATCHABLE,
];

/** The Composio triggers watching arms, by the bus name of the event each publishes. */
export const COMPOSIO_TRIGGERS: ReadonlyMap<string, ComposioTriggerSpec> = new Map(
  [
    { toolkit: "gmail", slug: GMAIL_TRIGGER_SLUG, config: GMAIL_TRIGGER_CONFIG },
    CALENDAR_STARTING_SOON,
    CALENDAR_EVENT_SYNC,
    CALENDAR_RSVP,
  ].map((spec) => [eventNameOf(fromComposio(spec)), spec]),
);

export const watchableOf = (source: string) => WATCHABLES.find((w) => w.source === source);
