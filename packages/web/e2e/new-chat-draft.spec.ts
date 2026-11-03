import { expect, test, type Page } from "@playwright/test";

const INPUT = "[data-chat-composer-box] textarea";
const KEY = "rome:new-chat-draft";

declare global {
  interface Window {
    draftWrites: string[];
  }
}

test.beforeEach(async ({ context, page }) => {
  // Fail closed even if a new write path bypasses the in-page mock transport.
  await context.route("**/api/**", (route) => {
    if (["GET", "HEAD"].includes(route.request().method())) return route.continue();
    return route.fulfill({ status: 503, json: { error: "Synthetic write rejection" } });
  });
  // MSW can answer a request before Playwright routes see it. Intercept writes
  // before MSW too, so the create failure cannot fall through to a real server.
  await page.addInitScript(() => {
    window.draftWrites = [];
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.origin)
        .pathname;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (path.startsWith("/api/") && !["GET", "HEAD"].includes(method)) {
        window.draftWrites.push(method + " " + path);
        if (path === "/api/chat/sessions" || /\/turns$/.test(path))
          return Response.json({ error: "Synthetic create/turn rejection" }, { status: 503 });
        return Response.json({ success: true });
      }
      return fetch(input, init);
    };
    // These tests send no attachments. An unexpected multipart write is a test
    // failure, never a request that can reach MSW or the backend.
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      if (!["GET", "HEAD"].includes(method.toUpperCase()))
        throw new Error("Unexpected XHR write: " + url);
      return Reflect.apply(open, this, [method, url, ...args]);
    } as typeof open;
  });
});

async function navigate(page: Page, path: string, state?: Record<string, unknown>) {
  await page.evaluate(
    ({ path, state }) =>
      window.dispatchEvent(new CustomEvent("rome:host-navigate", { detail: { path, state } })),
    { path, state },
  );
  await expect(page).toHaveURL(new URL(path, page.url()).href);
}

test("navigation and reload restore text/context, but do not replay consumed prefill", async ({
  page,
}) => {
  await page.goto("/chat");
  await expect(page.locator(INPUT)).toBeVisible();
  await navigate(page, "/chat", {
    draft: "explicit prefill",
    skill: "draft_skill",
    projectPath: "research",
    agentMention: { appId: "app", agentName: "agent", appLabel: "App" },
  });
  await expect(page.locator(INPUT)).toHaveValue("explicit prefill");
  const text = "  中文🙂 unsent\nsecond line  ";
  await page.locator(INPUT).fill(text);
  const draft = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), KEY);
  expect(draft).toMatchObject({
    text,
    projectPath: "research",
    agentMention: { agentName: "agent" },
    skill: { name: "draft_skill" },
  });
  await navigate(page, "/settings");
  await expect(page.locator(INPUT)).toHaveCount(0);
  await navigate(page, "/chat");
  await expect(page.locator(INPUT)).toHaveValue(text);
  await page.reload();
  await expect(page.locator(INPUT)).toHaveValue(text);
  await expect(page.getByRole("button", { name: /^(Remove skill|移除技能)$/ })).toBeVisible();
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), KEY)).toEqual(
    draft,
  );
  await page.screenshot({ path: test.info().outputPath("restored.png") });
});

test("failed create restores text/context and never posts to a real backend", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.locator(INPUT)).toBeVisible();
  await navigate(page, "/chat", {
    draft: "retry this",
    skill: "draft_skill",
    projectPath: "research",
  });
  await expect(page.locator(INPUT)).toHaveValue("retry this");
  await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
  await expect(page.getByText("Synthetic create/turn rejection", { exact: true })).toBeVisible();
  await expect(page.locator(INPUT)).toHaveValue("retry this");
  expect(
    await page.evaluate(() =>
      window.draftWrites.filter((path) => path.includes("/api/chat/sessions")),
    ),
  ).toEqual(["POST /api/chat/sessions"]);
  await page.reload();
  await expect(page.locator(INPUT)).toHaveValue("retry this");
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), KEY)).toMatchObject(
    { text: "retry this", projectPath: "research", skill: { name: "draft_skill" } },
  );
});
