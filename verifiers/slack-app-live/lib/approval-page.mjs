// Entry 1's browser side: open a Rome-produced "Add Slack" link as the
// signed-in tester and say which page Slack showed.

const INVALID_CLIENT = /invalid client_id parameter/i;
const ERROR_WORDS = /\b(error|something went wrong|invalid|not found|expired)\b/i;

/**
 * What a loaded page is, from its final URL, title, visible text and whether
 * it offers an Allow button:
 * - "approve": Slack's OAuth approval screen, offering Allow;
 * - "invalid-client": Slack's "Invalid client_id parameter" page;
 * - "signed-out": Slack sent the browser to sign in, so the cookie did not
 *   hold a session and the page proves nothing about the link;
 * - "error": any other page.
 */
export function classifyPage({ url, title = "", text = "", hasAllow = false }) {
  const at = new URL(url);
  if (INVALID_CLIENT.test(text) || INVALID_CLIENT.test(title)) return "invalid-client";
  if (/\/signin\b|\/sign_in\b|\/workspace-signin\b/.test(at.pathname) || /^sign in/i.test(title))
    return "signed-out";
  if (
    at.hostname.endsWith("slack.com") &&
    /^\/oauth(\/|$)/.test(at.pathname) &&
    hasAllow &&
    !ERROR_WORDS.test(title)
  )
    return "approve";
  return "error";
}

/**
 * Whether `link` has the shape Rome Cloud's install-url answer has: Slack's
 * OAuth authorize URL with a client_id, a state and a redirect_uri. A shape
 * check only; the link must still come from Rome Cloud itself.
 */
export function looksLikeInstallLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  const p = url.searchParams;
  return (
    url.protocol === "https:" &&
    url.hostname === "slack.com" &&
    url.pathname === "/oauth/v2/authorize" &&
    !!p.get("client_id") &&
    !!p.get("state") &&
    !!p.get("redirect_uri")
  );
}

/**
 * Opens `link` in Chromium with the tester's `d` cookie on .slack.com and
 * returns what `classifyPage` reads. Playwright is resolved from packages/web,
 * which declares it, so this folder adds no dependency.
 */
export async function loadApprovalPage(link, { dCookie, executablePath, timeoutMs = 30_000 }) {
  const { createRequire } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const webPackage = fileURLToPath(new URL("../../../packages/web/package.json", import.meta.url));
  const { chromium } = createRequire(webPackage)("@playwright/test");
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const context = await browser.newContext();
    await context.addCookies([
      { name: "d", value: dCookie, domain: ".slack.com", path: "/", secure: true, httpOnly: true },
    ]);
    const page = await context.newPage();
    const started = Date.now();
    const response = await page.goto(link, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
    const seen = {
      url: page.url(),
      status: response?.status() ?? null,
      title: await page.title(),
      text: await page
        .locator("body")
        .innerText({ timeout: timeoutMs })
        .catch(() => ""),
      hasAllow: (await page.getByRole("button", { name: /^allow$/i }).count()) > 0,
      ms: Date.now() - started,
    };
    return seen;
  } finally {
    await browser.close();
  }
}
