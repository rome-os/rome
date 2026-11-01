// Profile-owner Connect detection for the Rome `linkedin connect` override (connect.js).
//
// Every action control comes from the profile header: the card that holds the owner's visible
// name. Recommendation modules, sidebars, and cards that link to another member never count,
// and no lookup falls back to the whole page. Activating Connect can send the invitation at once,
// with no dialog, so only the `activate` mode ever clicks Connect.
import { canonicalizeLinkedInProfileUrl, normalizeName } from "./connect-receipt.mjs";

/**
 * Runs inside the LinkedIn profile page and must stay self-contained, because it is serialized
 * with Function#toString.
 *
 * - `probe` reads the owner header and clicks nothing.
 * - `inspect_more` opens the owner's More menu, reads its items, and closes it again. It clicks
 *   only the More control, never a menu item.
 * - `activate` clicks the owner's Connect control, directly or from the More menu. LinkedIn can
 *   send the invitation on that click.
 */
export async function linkedInConnectPage({ mode, expectedName, ownerVanity }) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) =>
    String(value ?? "")
      .replace(/[\u00a0\u202f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const normalizeName = (value) =>
    clean(value)
      .replace(/\s*[•·]\s*(?:1st|2nd|3rd\+?|degree connection).*$/i, "")
      .replace(/\s+LinkedIn.*$/i, "")
      .replace(/\b(p\.?eng\.?|cpa|mba|ph\.?d\.?)\b/gi, "")
      .replace(/[^\p{L}\p{N}\s.'-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const expected = normalizeName(expectedName);
  const ownerTokens = expected
    .replace(/[.'-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  const ariaLabel = (el) => clean(el?.getAttribute?.("aria-label"));
  const labelOf = (el) => clean(el?.innerText || el?.textContent) || ariaLabel(el);
  // offsetParent is null for position:fixed elements, and LinkedIn renders some menus that way.
  const visible = (el) => {
    if (!el?.isConnected) return false;
    if (el.offsetParent !== null) return true;
    const style = getComputedStyle(el);
    return style.position === "fixed" && style.display !== "none" && style.visibility !== "hidden";
  };
  const vanityOf = (href) => {
    try {
      const match = new URL(href, location.origin).pathname.match(/^\/in\/([^/]+)/i);
      return match ? decodeURIComponent(match[1]).toLowerCase() : "";
    } catch {
      return "";
    }
  };
  const inviteVanityOf = (el) => {
    try {
      const url = new URL(el.getAttribute("href") || "", location.origin);
      return /^\/preload\/custom-invite\/?$/i.test(url.pathname)
        ? (url.searchParams.get("vanityName") || "").toLowerCase()
        : "";
    } catch {
      return "";
    }
  };
  const owner = clean(ownerVanity).toLowerCase() || vanityOf(location.href);
  const namesOwner = (value) => {
    const label = value.toLowerCase();
    return ownerTokens.length > 0 && ownerTokens.every((token) => label.includes(token));
  };
  // LinkedIn names the member an action targets, as in "Invite Alex Example to connect".
  const targetOf = (el) => {
    const aria = ariaLabel(el);
    const match =
      aria.match(/^(?:invite|follow|unfollow|message|connect with)\s+(.+?)(?:\s+to connect)?$/i) ||
      aria.match(/\bsent to\s+(.+)$/i);
    return match ? match[1] : "";
  };

  const text = document.body ? document.body.innerText || document.body.textContent || "" : "";
  const authRequired =
    /\b(sign in|log in|join linkedin)\b/i.test(text) ||
    /linkedin\.com\/(login|checkpoint|authwall)/i.test(location.href) ||
    /captcha|verification required/i.test(text);
  const main = document.querySelector("main");
  const heading = main?.querySelector('h1, .text-heading-xlarge, [class*="heading-xlarge"]');
  const titleName = clean(
    (document.title || "").replace(/^\(\d+\+?\)\s*/, "").replace(/\s*[|｜]\s*LinkedIn\s*$/i, ""),
  );
  const name = clean(heading?.innerText || heading?.textContent) || titleName;

  // The header is the card around the first visible element that shows exactly the owner's name.
  const nameElement =
    main && expected
      ? Array.from(main.querySelectorAll("h1, h2, h3, h4, p, span, a, strong")).find((el) => {
          const value = el.textContent || "";
          return (
            value.length <= expected.length + 80 && normalizeName(value) === expected && visible(el)
          );
        })
      : null;
  const CARD = 'section, .pv-top-card, [data-view-name*="top-card" i], [componentkey*="topcard" i]';
  const CONTROL = 'button, a, [role="button"], [role="menuitem"]';

  // A subtree that links to another member's profile and does not hold the owner's name is that
  // member's card, such as a "People you may know" entry rendered inside the header.
  const foreignRootsOf = (root) => {
    const roots = [];
    for (const link of root.querySelectorAll('a[href*="/in/"]')) {
      const vanity = vanityOf(link.getAttribute("href"));
      if (!vanity || vanity === owner) continue;
      let node = link;
      while (node.parentElement && node.parentElement !== root) {
        if (nameElement && node.parentElement.contains(nameElement)) break;
        node = node.parentElement;
      }
      if (!nameElement || !node.contains(nameElement)) roots.push(node);
    }
    return roots;
  };
  const ownedBy = (root) => {
    const foreignRoots = foreignRootsOf(root);
    return (el) => {
      if (foreignRoots.some((foreignRoot) => foreignRoot.contains(el))) return false;
      const target = targetOf(el);
      if (target && !namesOwner(target)) return false;
      const inviteVanity = inviteVanityOf(el);
      return !inviteVanity || inviteVanity === owner;
    };
  };

  const lower = (el) => labelOf(el).toLowerCase();
  const isConnect = (el) => {
    const label = lower(el);
    return (
      label === "connect" ||
      label.startsWith("connect ") ||
      /^invite .+ to connect$/i.test(ariaLabel(el))
    );
  };
  const isPending = (el) => {
    const aria = ariaLabel(el).toLowerCase();
    return (
      lower(el) === "pending" || aria.startsWith("pending") || aria.includes("withdraw invitation")
    );
  };
  const isMore = (el) => {
    const label = lower(el);
    const aria = ariaLabel(el).toLowerCase();
    const opensMenu = el.tagName !== "A" || !el.getAttribute("href");
    return (
      opensMenu &&
      (label === "more" || label.startsWith("more ") || aria === "more" || aria.startsWith("more "))
    );
  };
  const isOwnerAction = (el) =>
    isConnect(el) ||
    isPending(el) ||
    isMore(el) ||
    /^(?:message|follow|following|unfollow)\b/.test(lower(el)) ||
    /^(?:message|follow|unfollow)\b/i.test(ariaLabel(el));
  const controlsOf = (root) => {
    const owned = ownedBy(root);
    return Array.from(root.querySelectorAll(CONTROL)).filter((el) => visible(el) && owned(el));
  };

  // Climb past name-only cards to the nearest one that also holds the owner's actions. Before the
  // actions render, the nearest card stands in so the caller can wait and probe again.
  let header = null;
  let controls = [];
  for (
    let card = nameElement?.closest(CARD);
    card && main && card !== main && main.contains(card);
    card = card.parentElement?.closest(CARD)
  ) {
    const cardControls = controlsOf(card);
    if (!header) {
      header = card;
      controls = cardControls;
    }
    if (cardControls.some(isOwnerAction)) {
      header = card;
      controls = cardControls;
      break;
    }
  }

  if (mode === "probe") {
    const owned = header ? ownedBy(header) : () => false;
    const degrees = new Set();
    for (const el of header ? [header, ...header.querySelectorAll("*")] : []) {
      if (!owned(el)) continue;
      const value = clean(el.textContent);
      const badge =
        (value.length <= 80 &&
          value.match(/(?:^|[•·])\s*(1st|2nd|3rd\+?)(?:[\s-]degree(?:\s+connection)?)?$/i)) ||
        `${ariaLabel(el)} ${el.getAttribute?.("title") || ""}`.match(
          /\b(1st|2nd|3rd\+?)[\s-]degree\b/i,
        );
      if (badge) degrees.add(badge[1].toLowerCase());
    }
    const connectAnchor = controls.find(
      (el) => el.tagName === "A" && isConnect(el) && inviteVanityOf(el),
    );
    return {
      url: location.href,
      title: document.title || "",
      name,
      authRequired,
      headerFound: Boolean(header),
      degree: Array.from(degrees).join(","),
      firstDegree: degrees.has("1st"),
      pending: controls.some(isPending),
      connectAvailable: controls.some(isConnect),
      connectHref: connectAnchor ? connectAnchor.getAttribute("href") || "" : "",
      moreAvailable: controls.some(isMore),
      ownerActions: controls.filter(isOwnerAction).map(labelOf).slice(0, 20),
      buttonLabels: controls.map(labelOf).filter(Boolean).slice(0, 30),
    };
  }

  if (!header) return { ok: false, reason: "owner_header_not_found" };

  const dialogs = () =>
    Array.from(document.querySelectorAll('[role="dialog"], dialog')).filter(visible);
  const activate = async (control, via) => {
    const before = new Set(dialogs());
    control.click();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(100);
      if (dialogs().some((dialog) => !before.has(dialog)))
        return { ok: true, opened: "dialog", via };
    }
    // LinkedIn can send the invitation on this click without showing a dialog.
    return { ok: true, opened: "no_dialog", via };
  };

  if (mode === "activate") {
    const direct = controls.find((el) => isConnect(el) && !isMore(el));
    if (direct) return activate(direct, "header");
  }

  const more = controls.find(isMore);
  if (!more) return { ok: false, reason: "owner_more_button_not_found" };
  const MENU = '[role="menu"], .artdeco-dropdown__content';
  const openBefore = new Set(Array.from(document.querySelectorAll(MENU)).filter(visible));
  const wasExpanded = more.getAttribute("aria-expanded") === "true";
  const menuCandidates = () => {
    const controlled = document.getElementById(more.getAttribute("aria-controls") || "");
    const local = more.closest(".artdeco-dropdown")?.querySelector(".artdeco-dropdown__content");
    const opened = Array.from(document.querySelectorAll(MENU))
      .filter((el) => !openBefore.has(el))
      .reverse();
    return Array.from(new Set([controlled, local, ...opened])).filter(visible);
  };
  const itemsOf = (candidate) => {
    const owned = ownedBy(candidate);
    return Array.from(
      candidate.querySelectorAll(
        '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="button"], button, a, li',
      ),
    ).filter((el) => visible(el) && owned(el) && labelOf(el));
  };
  if (!wasExpanded) more.click();
  // LinkedIn can show the dropdown before its items render, so a menu counts only once it has
  // items. A menu that stays empty is unreadable, never proof that Connect is absent.
  let menu = null;
  let items = [];
  let emptyMenu = null;
  for (let attempt = 0; attempt < 25 && !menu; attempt += 1) {
    await sleep(100);
    let pollEmpty = null;
    for (const candidate of menuCandidates()) {
      const candidateItems = itemsOf(candidate);
      if (candidateItems.length > 0) {
        menu = candidate;
        items = candidateItems;
        break;
      }
      pollEmpty ||= candidate;
    }
    // Keep the latest empty menu, since LinkedIn can replace the node while it loads.
    if (pollEmpty) emptyMenu = pollEmpty;
  }
  const close = async () => {
    if (wasExpanded || !visible(menu)) return true;
    const escape = { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", escape));
    await sleep(150);
    // More toggles its own menu, so a second click closes it when Escape did not.
    if (visible(menu)) {
      more.click();
      await sleep(250);
    }
    return !visible(menu);
  };
  if (!menu) {
    if (emptyMenu) {
      menu = emptyMenu;
      await close();
      return { ok: false, reason: "more_menu_empty" };
    }
    if (!wasExpanded && more.getAttribute("aria-expanded") === "true") more.click();
    return { ok: false, reason: "more_menu_not_found" };
  }

  // A menu item wraps its own label element, so act on the innermost match.
  const innermost = (matches) =>
    matches.find((el) => !matches.some((other) => other !== el && el.contains(other))) || null;
  const connectItem = innermost(items.filter(isConnect));
  const result = {
    ok: true,
    items: Array.from(new Set(items.map(labelOf))).slice(0, 30),
    connect: Boolean(connectItem),
    pending: items.some(isPending),
    removeConnection: items.some((el) => /^remove connection\b/.test(lower(el))),
  };

  if (mode === "activate") {
    if (!connectItem) {
      await close();
      return { ok: false, reason: "connect_control_not_found" };
    }
    return activate(connectItem, "more_menu");
  }
  return { ...result, closed: await close() };
}

/** Returns the `page.evaluate` source that runs `linkedInConnectPage` with these options. */
export function buildConnectPageScript(options) {
  return `(${linkedInConnectPage.toString()})(${JSON.stringify(options)})`;
}

/**
 * Runs inside LinkedIn's invitation dialog and must stay self-contained. Clicks Send, so it
 * runs only after the caller opted into sending.
 */
export async function linkedInInviteDialog(note) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const jitter = (min = 450, max = 1150) =>
    sleep(min + Math.floor(Math.random() * (max - min + 1)));
  const clean = (value) =>
    String(value ?? "")
      .replace(/[\u00a0\u202f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const visible = (el) => el && el.offsetParent !== null;
  const label = (el) => clean(el?.innerText || el?.textContent || el?.getAttribute("aria-label"));
  const dialog = () => document.querySelector('[role="dialog"]');
  const dialogButton = (pattern) =>
    Array.from(dialog()?.querySelectorAll('button, [role="button"]') || [])
      .filter(visible)
      .find((button) => pattern.test(label(button)));

  if (!dialog()) return { ok: false, status: "blocked", reason: "invite_dialog_not_found" };

  if (!note) {
    const sendDirect = dialogButton(/^send without a note$/i) || dialogButton(/^send$/i);
    if (!sendDirect) return { ok: false, status: "blocked", reason: "send_button_not_found" };
    await jitter();
    sendDirect.click();
    await jitter(1400, 2400);
    return { ok: true, status: "sent", reason: "invitation_sent_without_note" };
  }

  const addNote = dialogButton(/^add a note$/i);
  if (!addNote) return { ok: false, status: "blocked", reason: "add_note_button_not_found" };
  await jitter();
  addNote.click();
  await jitter(800, 1400);

  const textarea =
    document.querySelector("#custom-message") ||
    Array.from(document.querySelectorAll("textarea")).find(visible);
  if (!textarea) return { ok: false, status: "blocked", reason: "note_textarea_not_found" };
  textarea.focus();
  // React tracks the value through the native setter, so assigning .value would leave the
  // component state and the Send button unchanged.
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  ).set;
  setValue.call(textarea, note);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  await jitter(700, 1300);

  const send = dialogButton(/^send$/i);
  if (!send) return { ok: false, status: "blocked", reason: "send_button_not_found" };
  if (send.disabled || send.getAttribute("aria-disabled") === "true") {
    return { ok: false, status: "blocked", reason: "send_button_disabled" };
  }
  send.click();
  await jitter(1400, 2400);
  return { ok: true, status: "sent", reason: "invitation_sent_with_note" };
}

export function buildInviteDialogScript(note) {
  return `(${linkedInInviteDialog.toString()})(${JSON.stringify(note)})`;
}

/** Returns the lowercased public identifier of a LinkedIn /in/ profile URL, or "". */
export function linkedInProfileVanity(profileUrl) {
  const canonical = canonicalizeLinkedInProfileUrl(profileUrl);
  if (!canonical) return "";
  try {
    return decodeURIComponent(new URL(canonical).pathname.split("/")[2] || "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Returns the canonical invitation route for an owner Connect link, or "" when the link is not
 * LinkedIn's invitation route or names a different member than `ownerVanity`.
 */
export function canonicalizeLinkedInInviteUrl(value, ownerVanity) {
  try {
    const url = new URL(String(value ?? "").trim(), "https://www.linkedin.com");
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !(host === "linkedin.com" || host.endsWith(".linkedin.com")) ||
      !/^\/preload\/custom-invite\/?$/i.test(url.pathname)
    ) {
      return "";
    }
    const vanity = (url.searchParams.get("vanityName") || "").toLowerCase();
    if (!vanity || vanity !== String(ownerVanity ?? "").toLowerCase()) return "";
    url.hostname = "www.linkedin.com";
    url.hash = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    return "";
  }
}

function block(safety, blockReason, connectable = null) {
  return { ok: false, safety, connectable, blockReason };
}

/**
 * Classifies one profile from a `probe` result and, when the owner's Connect can only live in
 * the More menu, the `inspect_more` result.
 *
 * Returns `{ ok: true, method }` only for a Connect control the owner header proves. `method`
 * is `invite_link`, `header_button`, or `more_menu`. A `routine_non_connectable` block is a
 * confirmed state. An `unsafe_block` means the page could not be verified.
 */
export function assessConnectability(probe, menu, expectedName, expectedProfileUrl) {
  const expected = String(expectedName ?? "").trim();
  const actual = String(probe?.name ?? "").trim();
  const expectedUrl = canonicalizeLinkedInProfileUrl(expectedProfileUrl);
  const observedUrl = canonicalizeLinkedInProfileUrl(probe?.url);
  const context = { expectedValue: expected, actualValue: actual, observedUrl };
  const result = (verdict) => ({ ...verdict, ...context });

  if (probe?.authRequired) return result(block("unsafe_block", "auth_required"));
  if (!actual) return result(block("unsafe_block", "profile_name_not_found"));
  if (normalizeName(actual) !== normalizeName(expected)) {
    return result(block("unsafe_block", "profile_name_mismatch"));
  }
  if (expectedUrl && observedUrl && expectedUrl !== observedUrl) {
    return {
      ...block("unsafe_block", "profile_url_mismatch"),
      expectedValue: expectedUrl,
      actualValue: observedUrl,
      observedUrl,
    };
  }
  if (!probe.headerFound) return result(block("unsafe_block", "owner_header_not_found"));
  // The degree badge is read from the owner header only, so it outranks any Connect control.
  if (probe.firstDegree || menu?.removeConnection) {
    return result(block("routine_non_connectable", "already_connected", false));
  }
  if (probe.pending || menu?.pending) {
    return result(block("routine_non_connectable", "connection_pending", false));
  }
  if (probe.connectAvailable) {
    const method = probe.connectHref ? "invite_link" : "header_button";
    return result({
      ok: true,
      safety: "connectable",
      connectable: true,
      blockReason: "verified",
      method,
    });
  }
  if (probe.moreAvailable) {
    if (!menu?.ok) return result(block("unsafe_block", menu?.reason || "more_menu_not_inspected"));
    if (menu.connect) {
      return result({
        ok: true,
        safety: "connectable",
        connectable: true,
        blockReason: "verified_via_more",
        method: "more_menu",
      });
    }
    return result(block("routine_non_connectable", "connect_button_not_found", false));
  }
  if (Array.isArray(probe.ownerActions) && probe.ownerActions.length > 0) {
    return result(block("routine_non_connectable", "connect_button_not_found", false));
  }
  return result(block("unsafe_block", "owner_actions_not_found"));
}
