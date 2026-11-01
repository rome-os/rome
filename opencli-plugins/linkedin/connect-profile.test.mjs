import assert from "node:assert/strict";
import test from "node:test";
import {
  assessConnectability,
  buildConnectPageScript,
  canonicalizeLinkedInInviteUrl,
  linkedInProfileVanity,
} from "./connect-profile.mjs";
import {
  connectedHashedLayout,
  connectedWithoutHeader,
  connectLinkLayout,
  followOnlyLayout,
  followPrimaryLayout,
  headerWithoutActions,
  MENU_WITH_CONNECT,
  MENU_WITH_REMOVE_CONNECTION,
  MENU_WITHOUT_CONNECT,
  messageAndConnectLayout,
  namesakeBeforeHeader,
  nestedRecommendationLayout,
  OWNER_NAME,
  OWNER_URL,
  profileDom,
} from "./connect-test-fixtures.mjs";

const options = { expectedName: OWNER_NAME, ownerVanity: "jane-doe" };

// page.evaluate returns a serialized copy, so the tests compare one too.
async function run(page, mode) {
  const result = await page.dom.window.eval(buildConnectPageScript({ ...options, mode }));
  return JSON.parse(JSON.stringify(result));
}

async function classify(body, domOptions) {
  const page = profileDom(body, domOptions);
  const probe = await run(page, "probe");
  const menu =
    probe.headerFound && probe.moreAvailable && !probe.firstDegree && !probe.connectAvailable
      ? await run(page, "inspect_more")
      : null;
  return { page, probe, menu, verdict: assessConnectability(probe, menu, OWNER_NAME, OWNER_URL) };
}

test("#1542: a first-degree header badge wins over Connect controls in People you may know", async () => {
  for (const badge of [
    "<span>· 1st</span>",
    '<span class="visually-hidden">1st degree connection</span>',
    '<span aria-label="1st degree connection">·</span>',
  ]) {
    const { page, probe, verdict } = await classify(connectedHashedLayout(badge));
    assert.equal(probe.headerFound, true);
    assert.equal(probe.firstDegree, true, badge);
    assert.equal(probe.connectAvailable, false);
    assert.equal(probe.connectHref, "");
    assert.deepEqual(probe.buttonLabels, ["Message", "More"]);
    assert.equal(verdict.blockReason, "already_connected");
    assert.equal(verdict.connectable, false);
    assert.deepEqual(page.clicks, []);
  }
});

test("#1542: a namesake's card before the owner's header never stands in for it", async () => {
  for (const ownerName of ["<h1>Jane Doe</h1>", '<h2 class="n8v3">Jane Doe</h2>']) {
    const { page, probe, verdict } = await classify(namesakeBeforeHeader(ownerName));
    assert.equal(probe.headerFound, true, ownerName);
    assert.equal(probe.firstDegree, true, ownerName);
    assert.equal(probe.degree, "1st", ownerName);
    assert.equal(probe.connectAvailable, false, ownerName);
    assert.deepEqual(probe.buttonLabels, ["Message"], ownerName);
    assert.equal(verdict.blockReason, "already_connected", ownerName);
    assert.deepEqual(page.clicks, [], ownerName);

    const activate = profileDom(namesakeBeforeHeader(ownerName));
    assert.deepEqual(await run(activate, "activate"), {
      ok: false,
      reason: "owner_more_button_not_found",
    });
    assert.deepEqual(activate.clicks, [], ownerName);
  }
});

test("#1542: a page without an owner header is unverified, never connectable", async () => {
  const { probe, verdict } = await classify(connectedWithoutHeader);
  assert.equal(probe.name, OWNER_NAME);
  assert.equal(probe.headerFound, false);
  assert.equal(probe.connectAvailable, false);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.safety, "unsafe_block");
  assert.equal(verdict.blockReason, "owner_header_not_found");
});

test("#1491: Connect in the owner's More menu is found without activating it", async () => {
  const { page, probe, menu, verdict } = await classify(followPrimaryLayout(), {
    menuItems: MENU_WITH_CONNECT,
  });
  assert.equal(probe.connectAvailable, false);
  assert.equal(probe.moreAvailable, true);
  assert.equal(probe.degree, "3rd+");
  assert.equal(menu.connect, true);
  assert.equal(menu.closed, true);
  assert.equal(page.menuOpen(), false);
  assert.deepEqual(page.clicks, ["More"]);
  assert.deepEqual(verdict, {
    ok: true,
    safety: "connectable",
    connectable: true,
    blockReason: "verified_via_more",
    method: "more_menu",
    expectedValue: OWNER_NAME,
    actualValue: OWNER_NAME,
    observedUrl: OWNER_URL,
  });
});

test("a menu that ignores Escape is closed by toggling More, still without activating Connect", async () => {
  const { page, menu } = await classify(followPrimaryLayout(), {
    menuItems: MENU_WITH_CONNECT,
    menuMode: "toggle",
  });
  assert.equal(menu.connect, true);
  assert.equal(menu.closed, true);
  assert.equal(page.menuOpen(), false);
  assert.deepEqual(page.clicks, ["More", "More"]);
});

test("the More menu also settles connected and Follow-only profiles", async () => {
  const connected = await classify(followPrimaryLayout(), {
    menuItems: MENU_WITH_REMOVE_CONNECTION,
  });
  assert.equal(connected.verdict.blockReason, "already_connected");
  assert.deepEqual(connected.page.clicks, ["More"]);

  const followOnly = await classify(followPrimaryLayout(), { menuItems: MENU_WITHOUT_CONNECT });
  assert.equal(followOnly.verdict.blockReason, "connect_button_not_found");
  assert.equal(followOnly.verdict.safety, "routine_non_connectable");
  assert.deepEqual(followOnly.page.clicks, ["More"]);
});

test("a More control that opens no menu leaves the profile unverified", async () => {
  const { page, menu, verdict } = await classify(followPrimaryLayout());
  assert.deepEqual(menu, { ok: false, reason: "more_menu_not_found" });
  assert.equal(verdict.safety, "unsafe_block");
  assert.equal(verdict.blockReason, "more_menu_not_found");
  assert.deepEqual(page.clicks, ["More"]);
});

test("#1491: a More menu whose items render late is read once they appear", async () => {
  const { page, menu, verdict } = await classify(followPrimaryLayout(), {
    menuItems: MENU_WITH_CONNECT,
    menuItemsDelayMs: 400,
  });
  assert.equal(menu.connect, true);
  assert.equal(menu.closed, true);
  assert.equal(verdict.blockReason, "verified_via_more");
  assert.deepEqual(page.clicks, ["More"]);
});

test("#1491: a More menu that stays empty is unreadable, not proof that Connect is absent", async () => {
  const { page, menu, verdict } = await classify(followPrimaryLayout(), { menuItems: "" });
  assert.deepEqual(menu, { ok: false, reason: "more_menu_empty" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.safety, "unsafe_block");
  assert.equal(verdict.blockReason, "more_menu_empty");
  assert.equal(page.menuOpen(), false);
  assert.deepEqual(page.clicks, ["More"]);

  const activate = profileDom(followPrimaryLayout(), { menuItems: "" });
  assert.deepEqual(await run(activate, "activate"), { ok: false, reason: "more_menu_empty" });
  assert.deepEqual(activate.clicks, ["More"]);
  assert.equal(activate.menuOpen(), false);
});

test("Message beside the owner's own Connect stays connectable", async () => {
  const { page, probe, verdict } = await classify(messageAndConnectLayout);
  assert.equal(probe.degree, "2nd");
  assert.equal(probe.connectAvailable, true);
  assert.equal(probe.connectHref, "");
  assert.equal(verdict.blockReason, "verified");
  assert.equal(verdict.method, "header_button");
  assert.deepEqual(page.clicks, []);
});

test("only the owner's invitation link is captured", async () => {
  const { probe, verdict } = await classify(connectLinkLayout);
  assert.equal(probe.connectHref, "/preload/custom-invite/?vanityName=jane-doe");
  assert.equal(verdict.method, "invite_link");
});

test("another member's card nested in the header contributes no controls or badge", async () => {
  const { probe, menu, verdict } = await classify(nestedRecommendationLayout(""), {
    menuItems: MENU_WITHOUT_CONNECT,
  });
  assert.equal(probe.firstDegree, false);
  assert.equal(probe.connectAvailable, false);
  assert.deepEqual(probe.buttonLabels, ["Follow", "More"]);
  assert.equal(menu.connect, false);
  assert.equal(verdict.blockReason, "connect_button_not_found");

  const connected = await classify(nestedRecommendationLayout("<span>· 1st</span>"));
  assert.equal(connected.verdict.blockReason, "already_connected");
});

test("a header with no owner actions is unverified, while Follow alone is not connectable", async () => {
  const empty = await classify(headerWithoutActions);
  assert.equal(empty.probe.headerFound, true);
  assert.equal(empty.verdict.safety, "unsafe_block");
  assert.equal(empty.verdict.blockReason, "owner_actions_not_found");

  const followOnly = await classify(followOnlyLayout);
  assert.equal(followOnly.verdict.safety, "routine_non_connectable");
  assert.equal(followOnly.verdict.blockReason, "connect_button_not_found");
});

test("activate clicks only the owner's Connect menu item", async () => {
  const page = profileDom(followPrimaryLayout(), { menuItems: MENU_WITH_CONNECT });
  const opened = await run(page, "activate");
  assert.deepEqual(opened, { ok: true, opened: "no_dialog", via: "more_menu" });
  assert.deepEqual(page.clicks, ["More", "Connect"]);

  const direct = profileDom(messageAndConnectLayout);
  assert.deepEqual(await run(direct, "activate"), {
    ok: true,
    opened: "no_dialog",
    via: "header",
  });
  assert.deepEqual(direct.clicks, ["Connect"]);

  const missing = profileDom(followPrimaryLayout(), { menuItems: MENU_WITHOUT_CONNECT });
  assert.deepEqual(await run(missing, "activate"), {
    ok: false,
    reason: "connect_control_not_found",
  });
  assert.deepEqual(missing.clicks, ["More"]);
  assert.equal(missing.menuOpen(), false);
});

test("identity checks run before connection state", () => {
  const probe = { name: OWNER_NAME, url: OWNER_URL, headerFound: true, firstDegree: true };
  assert.equal(
    assessConnectability({ ...probe, authRequired: true }, null, OWNER_NAME, OWNER_URL).blockReason,
    "auth_required",
  );
  assert.equal(
    assessConnectability({ ...probe, name: "Janet Doe" }, null, OWNER_NAME, OWNER_URL).blockReason,
    "profile_name_mismatch",
  );
  assert.equal(
    assessConnectability(
      { ...probe, url: "https://www.linkedin.com/in/someone-else/" },
      null,
      OWNER_NAME,
      OWNER_URL,
    ).blockReason,
    "profile_url_mismatch",
  );
  assert.equal(
    assessConnectability(
      { ...probe, firstDegree: false, pending: true, connectAvailable: true },
      null,
      OWNER_NAME,
      OWNER_URL,
    ).blockReason,
    "connection_pending",
  );
});

test("invitation links must target the profile owner", () => {
  assert.equal(linkedInProfileVanity("https://ca.linkedin.com/in/Jane-Doe?trk=x"), "jane-doe");
  assert.equal(
    canonicalizeLinkedInInviteUrl("/preload/custom-invite/?vanityName=jane-doe", "jane-doe"),
    "https://www.linkedin.com/preload/custom-invite/?vanityName=jane-doe",
  );
  for (const href of [
    "/preload/custom-invite/?vanityName=alex-example",
    "/preload/custom-invite/",
    "https://www.linkedin.com/feed/",
    "https://evil-linkedin.com/preload/custom-invite/?vanityName=jane-doe",
  ]) {
    assert.equal(canonicalizeLinkedInInviteUrl(href, "jane-doe"), "", href);
  }
});
