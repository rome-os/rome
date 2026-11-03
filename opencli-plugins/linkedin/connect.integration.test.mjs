import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { getRegistry } from "@jackwener/opencli/registry";
import {
  connectedHashedLayout,
  connectLinkLayout,
  followPrimaryLayout,
  MENU_WITH_CONNECT,
  OWNER_NAME,
  OWNER_URL,
  profileDom,
} from "./connect-test-fixtures.mjs";

const require = createRequire(import.meta.url);
const registryEntry = require.resolve("@jackwener/opencli/registry");
const opencliRoot = resolve(dirname(registryEntry), "..", "..");

await import(pathToFileURL(join(opencliRoot, "clis/linkedin/sent-invitations.js")).href);
await import(pathToFileURL(join(opencliRoot, "clis/linkedin/connect.js")).href);

const upstreamConnect = getRegistry().get("linkedin/connect");
assert.ok(upstreamConnect);
await import("./connect.js");
const romeConnect = getRegistry().get("linkedin/connect");

const otherInviteUrl = "https://www.linkedin.com/preload/custom-invite/?vanityName=alex-example";
const sentUrl = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";
const dryRun = { "profile-url": OWNER_URL, "expected-name": OWNER_NAME };

// The sent-invitations page lists a navigation "Me" label, not the recipient.
function sentInvitationsDocument() {
  const navigationRow = {
    offsetParent: {},
    innerText: "Me",
    textContent: "Me",
    querySelector: (selector) =>
      selector === 'span[aria-hidden="true"], h3, h2'
        ? { textContent: "Me", innerText: "Me" }
        : null,
    querySelectorAll: () => [],
  };
  return {
    body: { innerText: "" },
    title: "LinkedIn",
    querySelectorAll(selector) {
      if (
        selector === "li, article, [data-view-name], .mn-invitation-card" ||
        selector === '[role="listitem"], li, article'
      ) {
        return [navigationRow];
      }
      return [];
    },
  };
}

/** Runs both the 1.8.8 command and Rome's override against the same fictional profile DOM. */
function fakePage(
  body,
  { menuItems = null, inviteResult, url = OWNER_URL, name = OWNER_NAME } = {},
) {
  const profile = profileDom(body, { menuItems, url, title: `${name} | LinkedIn` });
  let currentUrl = "";
  const page = {
    profile,
    visited: [],
    sendClicks: 0,
    goto: async (url) => {
      currentUrl = url;
      page.visited.push(url);
    },
    wait: async () => {},
    evaluate: async (script) => {
      if (currentUrl === url) {
        return JSON.parse(JSON.stringify(await profile.dom.window.eval(script)));
      }
      if (currentUrl.startsWith("https://www.linkedin.com/preload/custom-invite/")) {
        page.sendClicks += 1;
        return inviteResult ?? { ok: true, status: "sent", reason: "invitation_sent_without_note" };
      }
      if (currentUrl === sentUrl) {
        return vm.runInNewContext(script, {
          document: sentInvitationsDocument(),
          location: { href: currentUrl, origin: "https://www.linkedin.com" },
          URL,
        });
      }
      throw new Error(`Unexpected browser URL: ${currentUrl}`);
    },
  };
  return page;
}

test("#1542: 1.8.8 calls an existing connection connectable, and Rome does not", async () => {
  const [baseline] = await upstreamConnect.func(fakePage(connectedHashedLayout()), dryRun);
  assert.equal(baseline.status, "connectable_dry_run");
  assert.equal(baseline.connectable, true);

  const fixedPage = fakePage(connectedHashedLayout());
  const [fixed] = await romeConnect.func(fixedPage, dryRun);
  assert.equal(fixed.status, "not_connectable");
  assert.equal(fixed.reason, "already_connected");
  assert.equal(fixed.connectable, false);
  assert.deepEqual(fixedPage.profile.clicks, []);
});

test("#1542: a 1.8.8 send would open a recommended member's invitation, and Rome sends nothing", async () => {
  const baselinePage = fakePage(connectedHashedLayout(), {
    inviteResult: { ok: false, status: "blocked", reason: "invite_dialog_not_found" },
  });
  await assert.rejects(
    upstreamConnect.func(baselinePage, { ...dryRun, send: true }),
    /invite_dialog_not_found/,
  );
  assert.deepEqual(baselinePage.visited, [OWNER_URL, otherInviteUrl]);

  const fixedPage = fakePage(connectedHashedLayout());
  const [fixed] = await romeConnect.func(fixedPage, { ...dryRun, send: true });
  assert.equal(fixed.reason, "already_connected");
  assert.deepEqual(fixedPage.visited, [OWNER_URL]);
  assert.equal(fixedPage.sendClicks, 0);
});

test("#1491: 1.8.8 misses Connect in the owner's More menu, and Rome finds it without activating it", async () => {
  const [baseline] = await upstreamConnect.func(
    fakePage(followPrimaryLayout(), { menuItems: MENU_WITH_CONNECT }),
    dryRun,
  );
  assert.equal(baseline.status, "not_connectable");
  assert.equal(baseline.reason, "connect_button_not_found");

  const fixedPage = fakePage(followPrimaryLayout(), { menuItems: MENU_WITH_CONNECT });
  const [fixed] = await romeConnect.func(fixedPage, dryRun);
  assert.equal(fixed.status, "connectable_dry_run");
  assert.equal(fixed.reason, "verified_via_more");
  assert.deepEqual(fixedPage.profile.clicks, ["More"]);
  assert.equal(fixedPage.profile.menuOpen(), false);
});

test("the 1.8.8 DOM probe promotes a navigation Me label, and Rome rejects the same fixture", async () => {
  // "Example Member" contains "me", which the 1.8.8 name match accepts as a substring.
  const member = {
    url: "https://www.linkedin.com/in/example-member/",
    name: "Example Member",
  };
  const body = connectLinkLayout
    .replaceAll(OWNER_NAME, member.name)
    .replaceAll("jane-doe", "example-member");
  const args = { "profile-url": member.url, "expected-name": member.name, send: true };

  const baselinePage = fakePage(body, member);
  const [baselineReceipt] = await upstreamConnect.func(baselinePage, args);
  assert.equal(baselineReceipt.status, "sent_verified");
  assert.equal(baselineReceipt.delivery_verified, true);
  assert.equal(baselineReceipt.matched_invitation_name, "Me");
  assert.equal(baselineReceipt.matched_invitation_url, "");
  assert.equal(baselinePage.sendClicks, 1);

  const fixedPage = fakePage(body, member);
  const [fixedReceipt] = await romeConnect.func(fixedPage, args);
  assert.equal(fixedReceipt.status, "send_unverified");
  assert.equal(fixedReceipt.delivery_verified, false);
  assert.equal(fixedReceipt.matched_invitation_name, "");
  assert.equal(fixedReceipt.matched_invitation_url, "");
  assert.equal(fixedPage.sendClicks, 1);
});
