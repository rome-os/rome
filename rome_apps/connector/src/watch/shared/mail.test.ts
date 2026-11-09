import { describe, expect, it } from "@rstest/core";
import { addressesIn, isAutomatedSender } from "./mail.js";

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
});

describe("addressesIn", () => {
  it("finds every address in a header, lower-cased", () => {
    expect(addressesIn('"Lima, Ana" <Ana@X.io>, bo@y.io')).toEqual(["ana@x.io", "bo@y.io"]);
  });
});
