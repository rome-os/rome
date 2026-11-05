import { describe, expect, it } from "@rstest/core";
import type { ActiveTrigger } from "../api/composio-client.js";
import {
  CALENDAR_STARTING_SOON,
  COMPOSIO_TRIGGERS,
  LINEAR_COMMENT_CREATED,
  GMAIL_TRIGGER_CONFIG,
  GMAIL_TRIGGER_SLUG,
} from "./catalog.js";
import { armsWatch } from "./runtime.js";

const gmail = { toolkit: "gmail", slug: GMAIL_TRIGGER_SLUG, config: GMAIL_TRIGGER_CONFIG };
const armsGmailWatch = (t: ActiveTrigger, id: string) => armsWatch(t, gmail, id);

const trigger = (over: Partial<ActiveTrigger> = {}): ActiveTrigger => ({
  triggerInstanceId: "ti_1",
  triggerName: "GMAIL_NEW_GMAIL_MESSAGE",
  connectedAccountIds: ["ca_me", "uuid-me"],
  triggerConfig: { ...GMAIL_TRIGGER_CONFIG, interval: 1 },
  updatedAt: "2026-11-04T00:00:00Z",
  ...over,
});

describe("armsWatch", () => {
  it("counts the new-mail trigger for the connected account with this app's labels", () => {
    expect(armsGmailWatch(trigger(), "ca_me")).toBe(true);
    expect(armsGmailWatch(trigger(), "uuid-me")).toBe(true);
  });

  it("does not count one for another account, another label, or another trigger", () => {
    expect(armsGmailWatch(trigger(), "ca_other")).toBe(false);
    expect(armsGmailWatch(trigger({ triggerConfig: { labelIds: "SENT" } }), "ca_me")).toBe(false);
    expect(armsGmailWatch(trigger({ triggerConfig: {} }), "ca_me")).toBe(false);
    expect(armsGmailWatch(trigger({ triggerName: "GMAIL_EMAIL_SENT" }), "ca_me")).toBe(false);
  });
});

describe("armsWatch for Google Calendar", () => {
  const soon = trigger({
    triggerName: CALENDAR_STARTING_SOON.slug,
    triggerConfig: { ...CALENDAR_STARTING_SOON.config, interval: 1 },
  });

  it("counts the starting-soon trigger armed with this app's lead time", () => {
    expect(armsWatch(soon, CALENDAR_STARTING_SOON, "ca_me")).toBe(true);
  });

  it("does not count one with another lead time, or another Calendar trigger", () => {
    const later = { ...soon, triggerConfig: { ...soon.triggerConfig, minutesBeforeStart: 30 } };
    expect(armsWatch(later, CALENDAR_STARTING_SOON, "ca_me")).toBe(false);
    const other = [...COMPOSIO_TRIGGERS.values()].find(
      (spec) => spec.toolkit === "googlecalendar" && spec !== CALENDAR_STARTING_SOON,
    );
    expect(other && armsWatch(soon, other, "ca_me")).toBe(false);
  });
});

describe("armsWatch for a workspace-wide trigger", () => {
  const comments = trigger({ triggerName: LINEAR_COMMENT_CREATED.slug, triggerConfig: {} });

  it("counts one with no team set", () => {
    expect(armsWatch(comments, LINEAR_COMMENT_CREATED, "ca_me")).toBe(true);
    expect(
      armsWatch({ ...comments, triggerConfig: { team_id: "" } }, LINEAR_COMMENT_CREATED, "ca_me"),
    ).toBe(true);
  });

  it("does not count one narrowed to a team", () => {
    expect(
      armsWatch(
        { ...comments, triggerConfig: { team_id: "team-1" } },
        LINEAR_COMMENT_CREATED,
        "ca_me",
      ),
    ).toBe(false);
  });
});
