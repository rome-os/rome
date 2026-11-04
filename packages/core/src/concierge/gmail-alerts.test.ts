import { describe, expect, it } from "@rstest/core";
import { addressesIn, gmailAlertOf, gmailConnector } from "./gmail-alerts.js";

const me = "me@example.com";

const mail = (extra: Record<string, unknown> = {}) => ({
  message_id: "m1",
  thread_id: "t1",
  sender: "Ana Lima <ana@x.io>",
  to: "Me <me@example.com>",
  subject: "Lunch on Friday?",
  preview: { subject: "Lunch on Friday?", body: "Are you free on Friday at noon?" },
  label_ids: ["INBOX", "UNREAD", "IMPORTANT"],
  ...extra,
});

const withHeaders = (headers: Record<string, string>) =>
  mail({ payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } });

describe("gmailAlertOf", () => {
  it("makes an alert of mail a person sent the guardian", () => {
    expect(gmailAlertOf(mail(), me)).toEqual({
      id: "gmail:me@example.com:m1",
      source: "gmail",
      kind: "new_mail",
      fields: {
        mailbox: me,
        from: "Ana Lima <ana@x.io>",
        recipient: "to",
        subject: "Lunch on Friday?",
        url: "https://mail.google.com/mail/u/0/#all/t1",
      },
      text: "Are you free on Friday at noon?",
    });
  });

  it("keeps mail where the guardian is only in cc, marked as such", () => {
    const alert = gmailAlertOf(
      withHeaders({ To: "bo@y.io", Cc: "Me <ME@example.com>, zed@z.io" }),
      me,
    );
    expect(alert?.fields.recipient).toBe("to");
    const ccOnly = gmailAlertOf({ ...withHeaders({ Cc: "me@example.com" }), to: "bo@y.io" }, me);
    expect(ccOnly?.fields.recipient).toBe("cc");
  });

  it("drops mail Gmail filed as promotions, social, updates or forums, and mail outside the inbox", () => {
    for (const label of [
      "CATEGORY_PROMOTIONS",
      "CATEGORY_SOCIAL",
      "CATEGORY_UPDATES",
      "CATEGORY_FORUMS",
    ]) {
      expect(gmailAlertOf(mail({ label_ids: ["INBOX", label] }), me)).toBeNull();
    }
    expect(gmailAlertOf(mail({ label_ids: ["SENT"] }), me)).toBeNull();
  });

  it("drops automated senders and the guardian's own mail", () => {
    for (const sender of [
      "GitHub <noreply@github.com>",
      "no-reply@accounts.google.com",
      "notifications@stripe.com",
      "MAILER-DAEMON@mail.example.com",
      "do-not-reply+abc@bank.example",
    ]) {
      expect(gmailAlertOf(mail({ sender }), me)).toBeNull();
    }
    expect(gmailAlertOf(mail({ sender: "Me <me@example.com>" }), me)).toBeNull();
  });

  it("drops list and bulk mail by its headers", () => {
    expect(gmailAlertOf(withHeaders({ "List-Unsubscribe": "<mailto:u@x.io>" }), me)).toBeNull();
    expect(gmailAlertOf(withHeaders({ "List-Id": "team.x.io" }), me)).toBeNull();
    expect(gmailAlertOf(withHeaders({ Precedence: "bulk" }), me)).toBeNull();
  });

  it("reads camel-case fields too, and cuts a long body", () => {
    const alert = gmailAlertOf(
      {
        messageId: "m9",
        threadId: "t9",
        sender: "ana@x.io",
        to: me,
        subject: "Notes",
        labelIds: ["INBOX"],
        messageText: "x".repeat(500),
      },
      me,
    );
    expect(alert?.id).toBe("gmail:me@example.com:m9");
    expect(alert?.text?.length).toBe(301);
  });
});

describe("addressesIn", () => {
  it("finds every address in a header, lower-cased", () => {
    expect(addressesIn('"Lima, Ana" <Ana@X.io>, bo@y.io')).toEqual(["ana@x.io", "bo@y.io"]);
    expect(addressesIn(undefined)).toEqual([]);
  });
});

describe("gmailConnector", () => {
  it("arms the inbox trigger and reads the address from Gmail's profile", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const connector = gmailConnector(async (name, args) => {
      calls.push([name, args]);
      return name === "connector_proxy"
        ? { status: "ok", data: { status: 200, data: { emailAddress: "me@example.com" } } }
        : { status: "ok", data: { eventName: "provider:event:gmail.gmail_new_gmail_message" } };
    });
    expect(await connector.subscribe()).toEqual({ ok: true });
    expect(await connector.address()).toBe("me@example.com");
    expect(calls).toEqual([
      [
        "connector_event_subscribe",
        { toolkit: "gmail", slug: "GMAIL_NEW_GMAIL_MESSAGE", config: { labelIds: "INBOX" } },
      ],
      ["connector_proxy", { toolkit: "gmail", method: "GET", path: "/gmail/v1/users/me/profile" }],
    ]);
  });

  it("passes on the connector's refusal", async () => {
    const connector = gmailConnector(async () => ({
      status: "error",
      error: "Not signed in to Composio.",
    }));
    expect(await connector.subscribe()).toEqual({ ok: false, error: "Not signed in to Composio." });
    await expect(connector.address()).rejects.toThrow(/Not signed in/);
  });
});
