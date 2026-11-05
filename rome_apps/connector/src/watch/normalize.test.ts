import { describe, expect, it } from "@rstest/core";
import { CALENDAR_WATCHABLE, GITHUB_WATCHABLE } from "./catalog.js";
import {
  addressesIn,
  type GithubContext,
  isAutomatedSender,
  normalizeCalendar,
  normalizeGithub,
  normalizeGmail,
  whenOf,
} from "./normalize.js";

const repository = { full_name: "acme/widgets", default_branch: "main" };
const me = "Octo-Me";
const ALL_KINDS = new Set(GITHUB_WATCHABLE.kinds.map((k) => k.kind));

const ctx = (extra: Partial<GithubContext> = {}): GithubContext => ({
  login: me,
  kinds: ALL_KINDS,
  isTeamMember: async () => false,
  ...extra,
});

const pr = (user = "alice") => ({
  number: 7,
  title: "Fix it",
  html_url: "https://github.com/acme/widgets/pull/7",
  user: { login: user },
});

const reviewRequest = (extra: Record<string, unknown> = {}) => ({
  action: "review_requested",
  repository,
  organization: { login: "acme" },
  sender: { login: "alice" },
  pull_request: pr(),
  ...extra,
});

describe("normalizeGithub", () => {
  it("gives a review request in the common shape, direct when it is of the guardian", async () => {
    const mine = await normalizeGithub(
      "pull_request",
      reviewRequest({ requested_reviewer: { login: "octo-me" } }),
      ctx(),
    );
    expect(mine).toEqual({
      keep: true,
      event: {
        id: "github:acme/widgets:pr:7:review_requested:octo-me",
        source: "github",
        kind: "review_requested",
        actor: "alice",
        subject: "Fix it",
        url: "https://github.com/acme/widgets/pull/7",
        byYou: false,
        addressedTo: "direct",
        labels: ["pull-request", "review-requested"],
      },
    });
    // A request of someone else is kept too, addressed to others: triage decides.
    const theirs = await normalizeGithub(
      "pull_request",
      reviewRequest({ requested_reviewer: { login: "bob" } }),
      ctx(),
    );
    expect(theirs).toMatchObject({ keep: true, event: { addressedTo: "other" } });
  });

  it("tells a second request, a re-close or a re-assign apart, and keeps a redelivery's id", async () => {
    const idOf = async (type: string, payload: Record<string, unknown>) => {
      const result = await normalizeGithub(type, payload, ctx());
      return result.keep ? result.event.id : undefined;
    };
    const at = (updatedAt: string) => ({ ...pr(), updated_at: updatedAt });
    const request = (updatedAt: string) =>
      reviewRequest({ requested_reviewer: { login: "octo-me" }, pull_request: at(updatedAt) });
    const first = await idOf("pull_request", request("2026-11-04T10:00:00Z"));
    // The same webhook delivered again keeps its id, so it is dropped as a repeat.
    expect(await idOf("pull_request", request("2026-11-04T10:00:00Z"))).toBe(first);
    // A second request on the same pull request is a new event.
    expect(await idOf("pull_request", request("2026-11-05T09:00:00Z"))).not.toBe(first);

    const close = (updatedAt: string) => ({
      action: "closed",
      repository,
      sender: { login: "bob" },
      pull_request: { ...at(updatedAt), merged: false },
    });
    expect(await idOf("pull_request", close("2026-11-04T11:00:00Z"))).not.toBe(
      await idOf("pull_request", close("2026-11-04T12:00:00Z")),
    );
    const assign = (updatedAt: string) => ({
      action: "assigned",
      repository,
      sender: { login: "bob" },
      assignee: { login: "octo-me" },
      issue: { number: 3, title: "Bug", user: { login: "alice" }, updated_at: updatedAt },
    });
    expect(await idOf("issues", assign("2026-11-04T11:00:00Z"))).not.toBe(
      await idOf("issues", assign("2026-11-04T13:00:00Z")),
    );
  });

  it("makes a request of a team the guardian is on direct", async () => {
    const result = await normalizeGithub(
      "pull_request",
      reviewRequest({ requested_team: { slug: "core" } }),
      ctx({ isTeamMember: async (org, slug) => org === "acme" && slug === "core" }),
    );
    expect(result).toMatchObject({
      keep: true,
      event: { addressedTo: "direct", labels: ["pull-request", "review-requested", "team-review"] },
    });
  });

  it("marks the guardian's own actions and bots, and a mention as direct", async () => {
    const comment = (sender: string, body: string, threadAuthor = "alice") =>
      normalizeGithub(
        "issue_comment",
        {
          action: "created",
          repository,
          sender: { login: sender },
          issue: { number: 3, title: "Bug", user: { login: threadAuthor } },
          comment: { id: 9, body, html_url: "https://x/c/9" },
        },
        ctx(),
      );
    expect(await comment("octo-me", "On it")).toMatchObject({
      keep: true,
      event: { byYou: true, addressedTo: "other", labels: ["issue", "comment"] },
    });
    expect(await comment("bob", "@octo-me can you look?")).toMatchObject({
      keep: true,
      event: { byYou: false, addressedTo: "direct", labels: ["issue", "comment", "mention"] },
    });
    expect(await comment("bob", "thanks", "octo-me")).toMatchObject({
      event: { addressedTo: "direct" },
    });
    const bot = await normalizeGithub(
      "pull_request",
      {
        action: "opened",
        repository,
        sender: { login: "dependabot[bot]", type: "Bot" },
        pull_request: pr("dependabot[bot]"),
      },
      ctx(),
    );
    expect(bot).toMatchObject({
      keep: true,
      event: { kind: "new_pr_or_issue", labels: ["bot", "pull-request", "opened"] },
    });
  });

  it("gives every failed run, by the guardian when they triggered it, with labels", async () => {
    const run = (triggerer: string, branch: string) => ({
      action: "completed",
      repository,
      sender: { login: triggerer },
      workflow_run: {
        id: 11,
        run_attempt: 2,
        name: "CI",
        display_title: "Fix it",
        conclusion: "failure",
        head_branch: branch,
        html_url: "https://github.com/acme/widgets/actions/runs/11",
        triggering_actor: { login: triggerer },
        pull_requests: [{ number: 7 }],
      },
    });
    expect(await normalizeGithub("workflow_run", run("octo-me", "fix"), ctx())).toMatchObject({
      keep: true,
      event: {
        id: "github:acme/widgets:run:11:2",
        kind: "your_ci_failed",
        byYou: true,
        addressedTo: "direct",
        labels: ["ci-failed", "pull-request"],
      },
    });
    expect(await normalizeGithub("workflow_run", run("bob", "main"), ctx())).toMatchObject({
      keep: true,
      event: {
        byYou: false,
        addressedTo: "other",
        labels: ["ci-failed", "default-branch", "pull-request"],
      },
    });
    const passed = run("bob", "main");
    passed.workflow_run.conclusion = "success";
    expect(await normalizeGithub("workflow_run", passed, ctx())).toEqual({
      keep: false,
      reason: "not a failed run",
    });
  });

  it("drops only a kind the follow has off, or a shape no kind describes", async () => {
    const closed = {
      action: "closed",
      repository,
      sender: { login: "bob" },
      pull_request: { ...pr("octo-me"), merged: true },
    };
    expect(await normalizeGithub("pull_request", closed, ctx())).toMatchObject({
      keep: true,
      event: { kind: "your_pr_closed", addressedTo: "direct", labels: ["pull-request", "merged"] },
    });
    expect(
      await normalizeGithub("pull_request", closed, ctx({ kinds: new Set(["review_requested"]) })),
    ).toEqual({ keep: false, reason: "not a kind this follow has on" });
    expect(
      await normalizeGithub("pull_request", { ...closed, action: "synchronize" }, ctx()),
    ).toMatchObject({ keep: false });
  });
});

const address = "me@example.com";
const mail = (extra: Record<string, unknown> = {}) => ({
  message_id: "m1",
  thread_id: "t1",
  sender: "Ana Lima <ana@x.io>",
  to: "Me <me@example.com>",
  subject: "Lunch on Friday?",
  preview: { subject: "Lunch on Friday?", body: "Are you free on Friday at noon?" },
  label_ids: ["INBOX", "UNREAD"],
  ...extra,
});
const withHeaders = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  mail({
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
    ...extra,
  });

describe("normalizeGmail", () => {
  it("gives a new mail in the common shape", () => {
    expect(normalizeGmail(mail(), { address })).toEqual({
      keep: true,
      event: {
        id: "gmail:me@example.com:m1",
        source: "gmail",
        kind: "new_mail",
        actor: "Ana Lima <ana@x.io>",
        subject: "Lunch on Friday?",
        url: "https://mail.google.com/mail/u/0/#all/t1",
        excerpt: "Are you free on Friday at noon?",
        byYou: false,
        addressedTo: "direct",
        labels: [],
      },
    });
  });

  it("keeps cc, tabs, automated, list, bulk and own mail, each in the generic shape", () => {
    const event = (payload: Record<string, unknown>) => {
      const result = normalizeGmail(payload, { address });
      expect(result.keep).toBe(true);
      return result.keep ? result.event : undefined;
    };
    expect(event(withHeaders({ Cc: "me@example.com" }, { to: "bo@y.io" }))?.addressedTo).toBe(
      "copy",
    );
    expect(event(mail({ to: "list@x.io" }))?.addressedTo).toBe("other");
    expect(event(mail({ label_ids: ["INBOX", "CATEGORY_PROMOTIONS"] }))?.labels).toEqual([
      "promotions",
    ]);
    expect(event(mail({ label_ids: ["INBOX", "CATEGORY_UPDATES"] }))?.labels).toEqual(["updates"]);
    expect(event(mail({ sender: "noreply@github.com" }))?.labels).toEqual(["automated"]);
    expect(event(withHeaders({ "List-Unsubscribe": "<mailto:u@x.io>" }))?.labels).toEqual([
      "mailing-list",
    ]);
    expect(event(withHeaders({ Precedence: "bulk" }))?.labels).toEqual(["bulk"]);
    expect(event(mail({ sender: "me@example.com" }))?.byYou).toBe(true);
  });

  it("drops only spam, trash and a mail with no id", () => {
    expect(normalizeGmail(mail({ label_ids: ["SPAM"] }), { address })).toEqual({
      keep: false,
      reason: "spam or trash",
    });
    expect(normalizeGmail(mail({ label_ids: ["TRASH"] }), { address }).keep).toBe(false);
    expect(normalizeGmail(mail({ message_id: undefined }), { address }).keep).toBe(false);
  });

  it("reads camel-case fields too, and cuts a long body", () => {
    const result = normalizeGmail(
      {
        messageId: "m9",
        sender: "ana@x.io",
        to: address,
        labelIds: ["INBOX"],
        messageText: "x".repeat(900),
      },
      { address },
    );
    expect(result).toMatchObject({ keep: true, event: { id: "gmail:me@example.com:m9" } });
    expect(result.keep && result.event.excerpt?.length).toBe(501);
  });
});

describe("isAutomatedSender", () => {
  it("finds a no-reply, notification, bounce or mailer token anywhere in the local part", () => {
    for (const sender of [
      "jobalerts-noreply@linkedin.com",
      "noreply@github.com",
      "no-reply@accounts.google.com",
      "donotreply@bank.example",
      "do-not-reply@shop.example",
      "invoice+noreply@stripe.com",
      "notifications@github.com",
      "team.notification@vendor.example",
      "MAILER-DAEMON@mx.example",
      "postmaster@mail.example",
      "bounce-12345@em.sendgrid.net",
      "bounces+abc@mailgun.example",
    ]) {
      expect({ sender, automated: isAutomatedSender(sender) }).toEqual({ sender, automated: true });
    }
  });

  it("leaves a person whose name only contains those letters", () => {
    for (const sender of [
      "noriko@example.com",
      "bouncer.lee@example.com",
      "postmasterson@example.com",
      "ana@x.io",
      "notifyme.sam@example.com",
    ]) {
      expect({ sender, automated: isAutomatedSender(sender) }).toEqual({
        sender,
        automated: false,
      });
    }
  });

  it("marks such a sender on the mail, without dropping it", () => {
    const result = normalizeGmail(mail({ sender: "LinkedIn <jobalerts-noreply@linkedin.com>" }), {
      address,
    });
    expect(result).toMatchObject({ keep: true, event: { labels: ["automated"] } });
  });
});

describe("Gmail subjects and excerpts", () => {
  it("are cleaned of padding before they are kept", () => {
    const cgj = String.fromCodePoint(0x034f);
    const zwsp = String.fromCodePoint(0x200b);
    const result = normalizeGmail(
      mail({
        subject: `New jobs for you${zwsp}`,
        preview: { body: `3 new roles match your search ${`${cgj} `.repeat(60)}` },
      }),
      { address },
    );
    expect(result).toMatchObject({
      keep: true,
      event: { subject: "New jobs for you", excerpt: "3 new roles match your search" },
    });
  });
});

describe("addressesIn", () => {
  it("finds every address in a header, lower-cased", () => {
    expect(addressesIn('"Lima, Ana" <Ana@X.io>, bo@y.io')).toEqual(["ana@x.io", "bo@y.io"]);
  });
});

// Payloads shaped as Composio's googlecalendar trigger docs list them
// (docs.composio.dev/toolkits/googlecalendar), with Google's attendee objects.
describe("normalizeCalendar", () => {
  const address = "me@example.com";
  const all = { address, kinds: new Set(CALENDAR_WATCHABLE.kinds.map((k) => k.kind)) };
  const SOON = "googlecalendar_event_starting_soon_trigger";
  const SYNC = "googlecalendar_google_calendar_event_sync_trigger";
  const RSVP = "googlecalendar_attendee_response_changed_trigger";
  const attendees = [
    { email: "ana@x.io", displayName: "Ana", organizer: true, responseStatus: "accepted" },
    { email: "Me@Example.com", self: true, responseStatus: "needsAction" },
    { email: "room-4@resource.calendar.google.com", resource: true, responseStatus: "accepted" },
  ];
  const synced = (extra: Record<string, unknown> = {}) => ({
    calendar_id: "primary",
    event_id: "evt1",
    event_type: "created",
    status: "confirmed",
    summary: "Design review",
    description: "Agenda in the doc",
    location: "Room 4",
    start_time: "2026-11-05T15:00:00+08:00",
    end_time: "2026-11-05T16:00:00+08:00",
    created_at: "2026-11-04T09:00:00Z",
    updated_at: "2026-11-04T09:00:00Z",
    html_link: "https://www.google.com/calendar/event?eid=ZXZ0MQ",
    hangout_link: "https://meet.google.com/abc-defg-hij",
    organizer_email: "ana@x.io",
    organizer_name: "Ana Lima",
    creator_email: "ana@x.io",
    attendees,
    ...extra,
  });

  it("gives an invitation in the common shape, direct and waiting for the guardian's reply", () => {
    expect(normalizeCalendar(SYNC, synced(), all)).toEqual({
      keep: true,
      event: {
        id: "googlecalendar:me@example.com:evt1:invite:2026-11-04T09:00:00Z",
        source: "googlecalendar",
        kind: "invitations_and_changes",
        actor: "Ana Lima",
        subject: "Design review",
        url: "https://www.google.com/calendar/event?eid=ZXZ0MQ",
        excerpt: "2026-11-05 15:00–16:00 (+08:00). At Room 4. Agenda in the doc.",
        byYou: false,
        addressedTo: "direct",
        labels: ["invite", "online", "needs-reply"],
      },
    });
  });

  it("labels a change and a cancellation, and keeps each change apart from a repeat", () => {
    const changed = normalizeCalendar(
      SYNC,
      synced({ event_type: "updated", updated_at: "2026-11-04T10:00:00Z" }),
      all,
    );
    expect(changed).toMatchObject({
      keep: true,
      event: { id: "googlecalendar:me@example.com:evt1:updated:2026-11-04T10:00:00Z" },
    });
    expect(changed.keep && changed.event.labels[0]).toBe("updated");
    const deleted = normalizeCalendar(
      SYNC,
      { calendar_id: "primary", event_id: "evt1", event_type: "deleted" },
      all,
    );
    expect(deleted).toMatchObject({ keep: true, event: { labels: ["canceled", "no-guests"] } });
    const cancelled = normalizeCalendar(
      SYNC,
      synced({ event_type: "updated", status: "cancelled" }),
      all,
    );
    expect(cancelled.keep && cancelled.event.labels[0]).toBe("canceled");
  });

  it("says the guardian did it when they organized or created the event", () => {
    const own = normalizeCalendar(
      SYNC,
      synced({
        organizer_email: address,
        organizer_name: undefined,
        creator_email: address,
        attendees: [{ email: address, self: true, organizer: true, responseStatus: "accepted" }],
      }),
      all,
    );
    expect(own).toMatchObject({
      keep: true,
      event: {
        byYou: true,
        addressedTo: "direct",
        labels: ["created", "organizer", "no-guests", "online"],
      },
    });
  });

  it("marks an optional invitation as a copy, and one the guardian is not on as other", () => {
    const optional = normalizeCalendar(
      SYNC,
      synced({ attendees: [{ email: address, self: true, optional: true }, attendees[0]] }),
      all,
    );
    expect(optional.keep && optional.event.addressedTo).toBe("copy");
    const notOn = normalizeCalendar(SYNC, synced({ attendees: [attendees[0]] }), all);
    expect(notOn.keep && notOn.event.addressedTo).toBe("other");
  });

  it("gives a meeting about to start with its time and the link to join", () => {
    const result = normalizeCalendar(
      SOON,
      {
        calendar_id: "primary",
        countdown_window_minutes: 60,
        event_id: "evt1",
        summary: "Design review",
        start_time: "2026-11-05T07:00:00Z",
        start_timestamp: 1793948400,
        minutes_until_start: 9.6,
        html_link: "https://www.google.com/calendar/event?eid=ZXZ0MQ",
        hangout_link: "https://meet.google.com/abc-defg-hij",
        organizer_email: "ana@x.io",
        attendees: attendees.map((a) => (a.self ? { ...a, responseStatus: "declined" } : a)),
      },
      all,
    );
    expect(result).toEqual({
      keep: true,
      event: {
        id: "googlecalendar:me@example.com:evt1:starting:1793948400",
        source: "googlecalendar",
        kind: "meeting_starting_soon",
        actor: "ana@x.io",
        subject: "Design review",
        url: "https://meet.google.com/abc-defg-hij",
        excerpt: "Starts 2026-11-05 07:00 (UTC), in 10 minutes.",
        byYou: false,
        addressedTo: "direct",
        labels: ["starting-soon", "online", "you-declined"],
      },
    });
  });

  it("gives an attendee's reply, by the guardian when it is their own", () => {
    const reply = {
      attendee_email: "ana@x.io",
      attendee_name: "Ana Lima",
      calendar_id: "primary",
      event_html_link: "https://www.google.com/calendar/event?eid=ZXZ0MQ",
      event_id: "evt1",
      event_summary: "Design review",
      previous_response_status: "needsAction",
      response_status: "declined",
    };
    expect(normalizeCalendar(RSVP, reply, all)).toEqual({
      keep: true,
      event: {
        id: "googlecalendar:me@example.com:evt1:rsvp:ana@x.io:needsaction:declined",
        source: "googlecalendar",
        kind: "rsvp_changes",
        actor: "Ana Lima",
        subject: "Design review",
        url: "https://www.google.com/calendar/event?eid=ZXZ0MQ",
        excerpt: "Ana Lima answered declined.",
        byYou: false,
        addressedTo: "other",
        labels: ["rsvp", "declined"],
      },
    });
    const mine = normalizeCalendar(RSVP, { ...reply, attendee_email: "ME@example.com" }, all);
    expect(mine.keep && mine.event.byYou).toBe(true);
  });

  it("drops only a kind the follow has off, an event with no id, and an unknown trigger", () => {
    const soonOnly = { address, kinds: new Set(["meeting_starting_soon"]) };
    expect(normalizeCalendar(SYNC, synced(), soonOnly)).toEqual({
      keep: false,
      reason: "not a kind this follow has on",
    });
    expect(normalizeCalendar(SYNC, synced({ event_id: undefined }), all)).toEqual({
      keep: false,
      reason: "no event id",
    });
    expect(normalizeCalendar("googlecalendar_event_created_trigger", synced(), all).keep).toBe(
      false,
    );
  });
});

describe("whenOf", () => {
  it("reads an event's time in its own zone, a day-long event, and a span of days", () => {
    expect(whenOf("2026-11-05T15:00:00+08:00", "2026-11-05T16:30:00+08:00")).toBe(
      "2026-11-05 15:00–16:30 (+08:00)",
    );
    expect(whenOf("2026-11-05", "2026-11-06")).toBe("2026-11-05, all day");
    expect(whenOf("2026-11-05T22:00:00Z", "2026-11-06T01:00:00Z")).toBe(
      "2026-11-05 22:00 – 2026-11-06 01:00 (UTC)",
    );
    expect(whenOf(undefined, undefined)).toBeUndefined();
  });
});
