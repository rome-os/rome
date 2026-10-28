import assert from "node:assert/strict";
import test from "node:test";
import { cli, getRegistry, Strategy } from "@jackwener/opencli/registry";
import {
  canonicalizeLinkedInProfileUrl,
  matchesLinkedInSentInvitation,
} from "./connect-receipt.mjs";

cli({
  site: "linkedin",
  name: "connect",
  access: "write",
  description: "upstream connect fixture",
  domain: "www.linkedin.com",
  strategy: Strategy.UI,
  browser: true,
  aliases: ["invite"],
  args: [],
  columns: ["status", "delivery_verified", "matched_invitation_name", "matched_invitation_url"],
  func: async (page) => {
    page.connectCalls = (page.connectCalls ?? 0) + 1;
    return page.connectReceipt;
  },
});

cli({
  site: "linkedin",
  name: "sent-invitations",
  access: "read",
  description: "upstream sent-invitations fixture",
  domain: "www.linkedin.com",
  strategy: Strategy.UI,
  browser: true,
  func: async (page) => {
    page.verificationCalls = (page.verificationCalls ?? 0) + 1;
    if (page.verificationError) throw page.verificationError;
    return page.invitations;
  },
});

await import("./connect.js");

const command = getRegistry().get("linkedin/connect");
const expectedName = "Example Member";
const expectedProfileUrl = "https://ca.linkedin.com/in/example-member/?trk=profile";

function page(connectReceipt, invitations = []) {
  return { connectReceipt, invitations };
}

test("profile URL canonicalization rejects unsafe or non-profile URLs", () => {
  assert.equal(
    canonicalizeLinkedInProfileUrl("https://ca.linkedin.com/in/example-member?trk=profile#top"),
    "https://www.linkedin.com/in/example-member/",
  );
  for (const url of [
    "",
    "http://www.linkedin.com/in/example-member/",
    "https://evil-linkedin.com/in/example-member/",
    "https://www.linkedin.com/company/example/",
    "https://user:pass@www.linkedin.com/in/example-member/",
  ]) {
    assert.equal(canonicalizeLinkedInProfileUrl(url), "");
  }
});

test("invitation identity requires the same canonical profile URL and expected name tokens", () => {
  const valid = {
    name: "  Example Member · 2nd  ",
    profile_url: "https://www.linkedin.com/in/example-member/?trk=sent",
  };
  assert.equal(matchesLinkedInSentInvitation(valid, expectedName, expectedProfileUrl), true);

  for (const invitation of [
    { name: "Me", profile_url: "" },
    { name: expectedName, profile_url: "" },
    {
      name: expectedName,
      profile_url: "https://www.linkedin.com/in/someone-else/",
    },
    {
      name: "Someone Else",
      profile_url: "https://www.linkedin.com/in/example-member/",
    },
  ]) {
    assert.equal(
      matchesLinkedInSentInvitation(invitation, expectedName, expectedProfileUrl),
      false,
    );
  }

  assert.equal(
    matchesLinkedInSentInvitation(
      {
        name: "Jane Doe, PMP",
        profile_url: "https://www.linkedin.com/in/JANE-DOE/",
      },
      "Jane Doe",
      "https://ca.linkedin.com/in/jane-doe",
    ),
    true,
  );
  assert.equal(
    matchesLinkedInSentInvitation(
      {
        name: "Jane Doer",
        profile_url: "https://www.linkedin.com/in/jane-doe/",
      },
      "Jane Doe",
      "https://www.linkedin.com/in/jane-doe/",
    ),
    false,
  );
});

test("the wrapper preserves upstream command metadata and does not verify dry runs", async () => {
  assert.equal(command.access, "write");
  assert.equal(command.description, "upstream connect fixture");
  assert.equal(command.strategy, Strategy.UI);
  assert.equal(command, getRegistry().get("linkedin/invite"));

  const dryRun = page([{ status: "connectable_dry_run", connectable: true }]);
  const result = await command.func(dryRun, {
    send: false,
    "expected-name": expectedName,
    "profile-url": expectedProfileUrl,
  });

  assert.deepEqual(result, dryRun.connectReceipt);
  assert.equal(dryRun.connectCalls, 1);
  assert.equal(dryRun.verificationCalls, undefined);
});

test("a navigation label with no invitation URL cannot verify delivery", async () => {
  const sent = page(
    [
      {
        status: "sent_verified",
        delivery_verified: true,
        matched_invitation_name: "Me",
        matched_invitation_url: "",
      },
    ],
    [{ name: "Me", profile_url: "" }],
  );

  const [receipt] = await command.func(sent, {
    send: true,
    "expected-name": expectedName,
    "profile-url": expectedProfileUrl,
  });

  assert.equal(receipt.status, "send_unverified");
  assert.equal(receipt.delivery_verified, false);
  assert.equal(receipt.matched_invitation_name, "");
  assert.equal(receipt.matched_invitation_url, "");
  assert.equal(sent.connectCalls, 1);
  assert.equal(sent.verificationCalls, 1);
});

test("matching only the name or only the URL cannot verify delivery", async () => {
  for (const invitation of [
    {
      name: expectedName,
      profile_url: "https://www.linkedin.com/in/someone-else/",
    },
    {
      name: "Someone Else",
      profile_url: "https://www.linkedin.com/in/example-member/",
    },
    { name: expectedName, profile_url: "" },
  ]) {
    const sent = page([{ status: "send_unverified", delivery_verified: false }], [invitation]);
    const [receipt] = await command.func(sent, {
      send: true,
      "expected-name": expectedName,
      "profile-url": expectedProfileUrl,
    });

    assert.equal(receipt.status, "send_unverified");
    assert.equal(receipt.delivery_verified, false);
    assert.equal(sent.connectCalls, 1);
    assert.equal(sent.verificationCalls, 1);
  }
});

test("a sent-invitations row with both matching identity fields verifies delivery", async () => {
  const sent = page(
    [{ status: "send_unverified", delivery_verified: false }],
    [
      {
        name: "Example Member · 2nd",
        profile_url: "https://www.linkedin.com/in/example-member/?trk=sent",
      },
    ],
  );

  const [receipt] = await command.func(sent, {
    send: true,
    "expected-name": expectedName,
    "profile-url": expectedProfileUrl,
  });

  assert.equal(receipt.status, "sent_verified");
  assert.equal(receipt.delivery_verified, true);
  assert.equal(receipt.matched_invitation_name, "Example Member · 2nd");
  assert.equal(receipt.matched_invitation_url, "https://www.linkedin.com/in/example-member/");
  assert.equal(sent.connectCalls, 1);
  assert.equal(sent.verificationCalls, 1);
});

test("a failed post-send read leaves the outcome unverified without resending", async () => {
  const sent = page([{ status: "sent_verified", delivery_verified: true }]);
  sent.verificationError = new Error("sent invitation page unavailable");

  const [receipt] = await command.func(sent, {
    send: true,
    "expected-name": expectedName,
    "profile-url": expectedProfileUrl,
  });

  assert.equal(receipt.status, "send_unverified");
  assert.equal(receipt.reason, "sent_invitation_verification_failed");
  assert.equal(receipt.delivery_verified, false);
  assert.equal(sent.connectCalls, 1);
  assert.equal(sent.verificationCalls, 1);
});
