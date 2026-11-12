import { expect, type Page, test } from "@playwright/test";
import { installWidthStream } from "./chat-width-stream";

// 两个入口共享基础气泡，但只有普通聊天启用桌面 AI 正文宽度策略。
const CHATS = [
  { path: "/message", ready: "Nothing needs you before" },
  { path: "/chat/mock-chat-long-answers", ready: "Any time." },
];
const CHAT = CHATS[1];
const TEXT = "[data-chat-assistant-text]";
const COMPOSER = "[data-chat-composer-box]";
const LEGACY_WIDTH = `${TEXT} { max-width: min(100%, var(--container-2xl)) !important; }`;

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
});

async function open(page: Page, path = CHAT.path, ready = CHAT.ready) {
  await page.goto(path);
  await expect(page.getByText(ready).first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

function bubbleOverflow(page: Page) {
  return page.locator("[data-chat-bubble]").evaluateAll((bubbles) =>
    bubbles.map((bubble) => {
      const own = bubble.getBoundingClientRect();
      const column = bubble.parentElement!.getBoundingClientRect();
      return Math.max(0, own.right - column.right, column.left - own.left);
    }),
  );
}

async function expectNoOverflow(page: Page) {
  for (const overflow of await bubbleOverflow(page)) expect(overflow).toBeLessThan(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

for (const width of [320, 390]) {
  for (const { path, ready } of CHATS) {
    test(`bubbles stay inside their column at ${width}px in ${path}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, path, ready);
      await expectNoOverflow(page);
      const scroller = page.locator('[data-streamdown="table-wrapper"] > :has(> table)').first();
      expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    });
  }
}

for (const width of [1280, 1440, 1920]) {
  test(`desktop assistant text respects its cap and column at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const sizes = await page.locator(TEXT).evaluateAll((bubbles) =>
      bubbles.map((bubble) => ({
        width: bubble.getBoundingClientRect().width,
        available: bubble.parentElement!.getBoundingClientRect().width,
      })),
    );
    expect(sizes.length).toBeGreaterThan(1);
    for (const size of sizes) {
      expect(size.width).toBeLessThanOrEqual(Math.min(896, size.available) + 1);
    }
    // 示例回复有自己的自然宽度；达到 896px 的检查使用下方足够长的流式文本。
    expect(Math.max(...sizes.map((size) => size.width))).toBeGreaterThan(
      width === 1280 ? 600 : 672,
    );
    const short = page
      .getByText("Any time.", { exact: true })
      .locator("xpath=ancestor::*[@data-chat-bubble]");
    expect((await short.boundingBox())!.width).toBeLessThan(200);
    for (const cap of await page
      .locator(".rome-bubble-on-primary")
      .evaluateAll((bubbles) => bubbles.map((bubble) => bubble.getBoundingClientRect().width)))
      expect(cap).toBeLessThanOrEqual(672.5);
    await expectNoOverflow(page);
  });

  test(`widening text leaves composer geometry unchanged at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const wide = await page.locator(COMPOSER).boundingBox();
    const oldWidth = await page.addStyleTag({ content: LEGACY_WIDTH });
    expect(await page.locator(COMPOSER).boundingBox()).toEqual(wide);
    await oldWidth.evaluate((element) => {
      element.parentNode?.removeChild(element);
    });
    expect(await page.locator(COMPOSER).boundingBox()).toEqual(wide);
  });
}

test("Concierge retains its own desktop width policy", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await open(page, CHATS[0].path, CHATS[0].ready);
  const widths = await page
    .locator("[data-chat-bubble]")
    .evaluateAll((bubbles) => bubbles.map((bubble) => bubble.getBoundingClientRect().width));
  expect(widths.length).toBeGreaterThan(0);
  for (const width of widths) expect(width).toBeLessThanOrEqual(672.5);
});

test("a narrowed desktop column contains wide tables and code", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installWidthStream(page);
  await open(page);
  const columns = Array.from({ length: 20 }, (_, index) => `Column ${index}`);
  const content = [
    "## Wide content",
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    `| ${columns.map(() => "reference-value").join(" | ")} |`,
    "",
    "```text",
    "long-code-".repeat(100),
    "```",
  ].join("\n");
  await expect.poll(() => page.evaluate(() => !!window.chatWidthStream?.ready)).toBe(true);
  await page.evaluate((text) => window.chatWidthStream.push(text), content);
  await expect(page.locator(".rome-live-caret table")).toBeAttached({ timeout: 20_000 });
  await expect(page.locator(".rome-live-caret [data-chat-code-block]")).toBeAttached({
    timeout: 20_000,
  });
  await expectNoOverflow(page);
  const table = page.locator('.rome-live-caret [data-streamdown="table-wrapper"] > :has(> table)');
  expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const code = page.locator(".rome-live-caret [data-chat-code-block]");
  await expect
    .poll(() =>
      code.evaluate((element) =>
        [element, ...element.querySelectorAll("*")].some(
          (node) =>
            ["auto", "scroll"].includes(getComputedStyle(node).overflowX) &&
            node.scrollWidth > node.clientWidth,
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => window.chatWidthStream.finish());
});

test("streaming and saved assistant text use the same width policy", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await installWidthStream(page);
  await open(page);
  await expect.poll(() => page.evaluate(() => !!window.chatWidthStream?.ready)).toBe(true);
  await page.evaluate(() => window.chatWidthStream.push("Live width"));
  const live = page.locator(`.rome-live-caret ${TEXT}`);
  await expect(live).toContainText("Live width");
  expect((await live.boundingBox())!.width).toBeLessThan(200);
  const answer = "Streaming width stays consistent across the saved handoff. ".repeat(8).trim();
  await page.evaluate((text) => window.chatWidthStream.push(text), answer);
  await expect(live).toHaveText(answer, { timeout: 20_000 });
  const before = (await live.boundingBox())!.width;
  expect(Math.abs(before - 896)).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.chatWidthStream.finish());
  await expect(live).toHaveCount(0);
  const saved = page.locator(`[data-chat-card-message="width-answer"] ${TEXT}`);
  await expect(saved).toHaveText(answer);
  expect(Math.abs((await saved.boundingBox())!.width - before)).toBeLessThanOrEqual(1);
  await saved.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("saved-896.png") });
});

test("opening a trace panel narrows the text column without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await installWidthStream(page);
  await open(page);
  await expect.poll(() => page.evaluate(() => !!window.chatWidthStream?.ready)).toBe(true);
  const answer = "A long answer must follow the available column when a trace panel opens. "
    .repeat(12)
    .trim();
  await page.evaluate((text) => window.chatWidthStream.push(text), answer);
  const live = page.locator(`.rome-live-caret ${TEXT}`);
  await expect(live).toHaveText(answer, { timeout: 20_000 });
  const before = (await live.boundingBox())!.width;
  await page.locator('[class~="@container/message"]').last().getByRole("button").first().click();
  await expect(page.getByRole("tabpanel", { name: "Trace Live", exact: true })).toBeVisible();
  await expect.poll(async () => (await live.boundingBox())!.width).toBeLessThan(before);
  await expectNoOverflow(page);
  await page.screenshot({ path: test.info().outputPath("trace-narrowed.png") });
  await page.getByRole("button", { name: "Close Trace", exact: true }).click();
  await expect.poll(async () => (await live.boundingBox())!.width).toBeCloseTo(before, 0);
  await page.evaluate(() => window.chatWidthStream.finish());
});

test("public shares retain the default assistant cap", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.origin)
        .pathname;
      if (path === "/api/share/width-share") {
        return Response.json({
          id: "width-share",
          title: "Shared width",
          snapshot: {
            mainSessionId: "shared-session",
            messages: [
              {
                id: "shared-answer",
                sessionId: "shared-session",
                turnId: "shared-turn",
                role: "assistant",
                createdAt: "2026-06-01T10:00:00.000Z",
                content: JSON.stringify([
                  {
                    type: "text",
                    content: "Shared answers keep their own reading width. ".repeat(30),
                  },
                ]),
              },
            ],
            traces: {},
            agentName: "assistant",
          },
          layout: [],
        });
      }
      return fetch(input, init);
    };
  });
  await page.goto("/share/width-share");
  const bubble = page.locator(TEXT);
  await expect(bubble).toBeVisible({ timeout: 30_000 });
  expect(Math.abs((await bubble.boundingBox())!.width - 672)).toBeLessThanOrEqual(1);
  await expectNoOverflow(page);
});
