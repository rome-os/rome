import { describe, expect, it } from "@rstest/core";
import { normalizeGmail } from "./normalize.js";

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
