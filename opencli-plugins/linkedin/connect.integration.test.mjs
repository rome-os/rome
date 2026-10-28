import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { getRegistry } from "@jackwener/opencli/registry";

const require = createRequire(import.meta.url);
const registryEntry = require.resolve("@jackwener/opencli/registry");
const opencliRoot = resolve(dirname(registryEntry), "..", "..");

await import(pathToFileURL(join(opencliRoot, "clis/linkedin/sent-invitations.js")).href);
await import(pathToFileURL(join(opencliRoot, "clis/linkedin/connect.js")).href);

const upstreamConnect = getRegistry().get("linkedin/connect");
assert.ok(upstreamConnect);
await import("./connect.js");
const romeConnect = getRegistry().get("linkedin/connect");

const profileUrl = "https://www.linkedin.com/in/example-member/";
const inviteUrl = "https://www.linkedin.com/preload/custom-invite/?vanityName=example-member";
const sentUrl = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";
const args = {
  "profile-url": profileUrl,
  "expected-name": "Example Member",
  send: true,
};

function fakePage() {
  let currentUrl = "";
  let sendClicks = 0;
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
  const document = {
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

  return {
    get sendClicks() {
      return sendClicks;
    },
    goto: async (url) => {
      currentUrl = url;
    },
    wait: async () => {},
    evaluate: async (script) => {
      if (currentUrl === profileUrl) {
        return {
          url: profileUrl,
          name: "Example Member",
          authRequired: false,
          alreadyConnected: false,
          pending: false,
          connectAvailable: true,
          moreAvailable: false,
          connectHref: inviteUrl,
          buttonLabels: ["Connect"],
        };
      }
      if (currentUrl === inviteUrl) {
        sendClicks += 1;
        return {
          ok: true,
          status: "sent",
          reason: "invitation_sent_without_note",
        };
      }
      if (currentUrl === sentUrl) {
        return vm.runInNewContext(script, {
          document,
          location: { href: currentUrl, origin: "https://www.linkedin.com" },
          URL,
        });
      }
      throw new Error(`Unexpected browser URL: ${currentUrl}`);
    },
  };
}

test("the 1.8.8 DOM probe promotes a navigation Me label, and Rome rejects the same fixture", async () => {
  const baselinePage = fakePage();
  const [baselineReceipt] = await upstreamConnect.func(baselinePage, args);
  assert.equal(baselineReceipt.status, "sent_verified");
  assert.equal(baselineReceipt.delivery_verified, true);
  assert.equal(baselineReceipt.matched_invitation_name, "Me");
  assert.equal(baselineReceipt.matched_invitation_url, "");
  assert.equal(baselinePage.sendClicks, 1);

  const fixedPage = fakePage();
  const [fixedReceipt] = await romeConnect.func(fixedPage, args);
  assert.equal(fixedReceipt.status, "send_unverified");
  assert.equal(fixedReceipt.delivery_verified, false);
  assert.equal(fixedReceipt.matched_invitation_name, "");
  assert.equal(fixedReceipt.matched_invitation_url, "");
  assert.equal(fixedPage.sendClicks, 1);
});
