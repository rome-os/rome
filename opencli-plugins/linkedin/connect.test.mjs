import assert from "node:assert/strict";
import test from "node:test";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, getRegistry, Strategy } from "@jackwener/opencli/registry";
import {
  canonicalizeLinkedInProfileUrl,
  matchesLinkedInSentInvitation,
} from "./connect-receipt.mjs";
import {
  connectedHashedLayout,
  connectedWithoutHeader,
  connectLinkLayout,
  followPrimaryLayout,
  MENU_WITH_CONNECT,
  OWNER_URL,
  profileDom,
} from "./connect-test-fixtures.mjs";

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
  func: async () => {
    throw new Error("Rome's override must not delegate to the upstream connect command");
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
    page.verificationCalls += 1;
    if (page.verificationError) throw page.verificationError;
    return page.invitations;
  },
});

await import("./connect.js");

const command = getRegistry().get("linkedin/connect");
const expectedName = "Example Member";
const expectedProfileUrl = "https://ca.linkedin.com/in/example-member/?trk=profile";
const ownerArgs = { "profile-url": OWNER_URL, "expected-name": "Jane Doe" };

/**
 * A browser page whose profile URL is a jsdom fixture. The invitation route answers with
 * `inviteResult`, and the sent-invitations fixture command reads `invitations`.
 */
function fakePage(body, { domOptions = {}, invitations = [], inviteResult } = {}) {
  const profile = profileDom(body, domOptions);
  let currentUrl = "";
  const page = {
    profile,
    visited: [],
    inviteRuns: 0,
    verificationCalls: 0,
    invitations,
    goto: async (url) => {
      currentUrl = url;
      page.visited.push(url);
    },
    wait: async () => {},
    evaluate: async (script) => {
      if (currentUrl === OWNER_URL) {
        return JSON.parse(JSON.stringify(await profile.dom.window.eval(script)));
      }
      if (currentUrl.startsWith("https://www.linkedin.com/preload/custom-invite/")) {
        page.inviteRuns += 1;
        return inviteResult ?? { ok: true, status: "sent", reason: "invitation_sent_without_note" };
      }
      throw new Error(`Unexpected browser URL: ${currentUrl}`);
    },
  };
  return page;
}

function receiptPage(invitations) {
  return fakePage(connectLinkLayout, { invitations });
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

test("the override keeps the upstream identity and documents that Connect can send at once", () => {
  assert.equal(command.access, "write");
  assert.equal(command.strategy, Strategy.UI);
  assert.equal(command, getRegistry().get("linkedin/invite"));
  const send = command.args.find((arg) => arg.name === "send");
  assert.equal(send.default, false);
  assert.match(send.help, /moment Connect is activated/);
  assert.match(command.description, /never activate Connect/);
});

test("#1542: an existing connection is not connectable despite recommendation Connect controls", async () => {
  for (const send of [false, true]) {
    const page = fakePage(connectedHashedLayout());
    const [receipt] = await command.func(page, { ...ownerArgs, send });
    assert.deepEqual(receipt, {
      status: "not_connectable",
      recipient: "Jane Doe",
      reason: "already_connected",
      profile_url: OWNER_URL,
      note_chars: 0,
      connectable: false,
    });
    assert.deepEqual(page.visited, [OWNER_URL]);
    assert.deepEqual(page.profile.clicks, []);
    assert.equal(page.verificationCalls, 0);
  }
});

test("#1542: a profile without an owner header blocks instead of reporting connectable", async () => {
  const page = fakePage(connectedWithoutHeader);
  await assert.rejects(
    command.func(page, { ...ownerArgs, send: true }),
    (error) =>
      error instanceof CommandExecutionError && /owner_header_not_found/.test(error.message),
  );
  assert.deepEqual(page.visited, [OWNER_URL]);
  assert.deepEqual(page.profile.clicks, []);
});

test("#1491: a dry run finds Connect in the More menu and clicks only More", async () => {
  const page = fakePage(followPrimaryLayout(), { domOptions: { menuItems: MENU_WITH_CONNECT } });
  const [receipt] = await command.func(page, { ...ownerArgs, note: "Hello from Example Co" });
  assert.deepEqual(receipt, {
    status: "connectable_dry_run",
    recipient: "Jane Doe",
    reason: "verified_via_more",
    profile_url: OWNER_URL,
    note_chars: 21,
    connectable: true,
  });
  assert.deepEqual(page.profile.clicks, ["More"]);
  assert.equal(page.profile.menuOpen(), false);
  assert.deepEqual(page.visited, [OWNER_URL]);
});

test("#1491: a send activates the owner's More-menu Connect and verifies the invitation", async () => {
  const page = fakePage(followPrimaryLayout(), {
    domOptions: { menuItems: MENU_WITH_CONNECT },
    invitations: [{ name: "Jane Doe", profile_url: OWNER_URL }],
  });
  const [receipt] = await command.func(page, { ...ownerArgs, send: true });
  assert.equal(receipt.status, "sent_verified");
  assert.equal(receipt.delivery_verified, true);
  assert.equal(receipt.matched_invitation_url, OWNER_URL);
  assert.deepEqual(page.profile.clicks, ["More", "More", "Connect"]);
  assert.equal(page.inviteRuns, 0);
  assert.equal(page.verificationCalls, 1);
});

test("a send through an invitation link navigates only to the owner's invitation", async () => {
  const page = receiptPage([{ name: "Jane Doe", profile_url: OWNER_URL }]);
  const [receipt] = await command.func(page, { ...ownerArgs, send: true });
  assert.equal(receipt.status, "sent_verified");
  assert.deepEqual(page.visited, [
    OWNER_URL,
    "https://www.linkedin.com/preload/custom-invite/?vanityName=jane-doe",
  ]);
  assert.equal(page.inviteRuns, 1);
  assert.deepEqual(page.profile.clicks, []);
});

test("a navigation label with no invitation URL cannot verify delivery", async () => {
  const sent = receiptPage([{ name: "Me", profile_url: "" }]);
  const [receipt] = await command.func(sent, { ...ownerArgs, send: true });

  assert.equal(receipt.status, "send_unverified");
  assert.equal(receipt.reason, "sent_invitation_not_found_after_retries");
  assert.equal(receipt.delivery_verified, false);
  assert.equal(receipt.matched_invitation_name, "");
  assert.equal(receipt.matched_invitation_url, "");
  assert.equal(sent.inviteRuns, 1);
  assert.equal(sent.verificationCalls, 3);
});

test("matching only the name or only the URL cannot verify delivery", async () => {
  for (const invitation of [
    { name: "Jane Doe", profile_url: "https://www.linkedin.com/in/someone-else/" },
    { name: "Someone Else", profile_url: OWNER_URL },
    { name: "Jane Doe", profile_url: "" },
  ]) {
    const sent = receiptPage([invitation]);
    const [receipt] = await command.func(sent, { ...ownerArgs, send: true });

    assert.equal(receipt.status, "send_unverified");
    assert.equal(receipt.delivery_verified, false);
    assert.equal(sent.inviteRuns, 1);
  }
});

test("a failed post-send read leaves the outcome unverified without resending", async () => {
  const sent = receiptPage([]);
  sent.verificationError = new Error("sent invitation page unavailable");

  const [receipt] = await command.func(sent, { ...ownerArgs, send: true });

  assert.equal(receipt.status, "send_unverified");
  assert.equal(receipt.reason, "sent_invitation_verification_failed");
  assert.equal(receipt.delivery_verified, false);
  assert.equal(sent.inviteRuns, 1);
  assert.equal(sent.verificationCalls, 3);
});
