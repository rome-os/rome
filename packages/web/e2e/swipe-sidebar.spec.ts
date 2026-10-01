import { type CDPSession, expect, type Page, test } from "@playwright/test";

/**
 * On a phone a swipe right anywhere drags the sidebar out and pushes the page
 * right; a swipe left or a tap on the dimmed page closes it. The gestures go
 * through the browser's own touch pipeline (CDP `Input.dispatchTouchEvent`),
 * so passive listeners, `preventDefault` and hit testing are the real ones.
 *
 * /settings/appearance is the stage because it scrolls the document and keeps
 * still: chat scrolls itself to the newest turn, which would move a point
 * between measuring it and touching it.
 */
const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

async function open(page: Page) {
  await page.goto("/settings/appearance");
  // The settings heading, not the mobile header: from 768px up there is none.
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);
  return page.context().newCDPSession(page);
}

async function swipe(cdp: CDPSession, from: [number, number], toX: number, toY = from[1]) {
  const steps = 12;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from[0], y: from[1] }],
  });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from[0] + ((toX - from[0]) * i) / steps,
          y: from[1] + ((toY - from[1]) * i) / steps,
        },
      ],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const geometry = (page: Page) =>
  page.evaluate(() => ({
    sidebarLeft: Math.round(document.querySelector("aside")!.getBoundingClientRect().left),
    pageLeft: Math.round(document.querySelector("main")!.getBoundingClientRect().left),
    overflowX:
      Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  }));

const OPEN = { sidebarLeft: 0, pageLeft: 256, overflowX: 0 };
const SHUT = { sidebarLeft: -256, pageLeft: 0, overflowX: 0 };

test("a swipe right opens the sidebar and pushes the page", async ({ page }) => {
  const cdp = await open(page);
  await swipe(cdp, [100, 420], 330);
  await expect.poll(() => geometry(page)).toEqual(OPEN);
});

test("a swipe left on the open sidebar closes it", async ({ page }) => {
  const cdp = await open(page);
  await swipe(cdp, [100, 420], 330);
  await expect.poll(() => geometry(page)).toEqual(OPEN);
  await swipe(cdp, [230, 420], 20);
  await expect.poll(() => geometry(page)).toEqual(SHUT);
});

test("a tap on the dimmed page closes it", async ({ page }) => {
  const cdp = await open(page);
  await swipe(cdp, [100, 420], 330);
  await expect.poll(() => geometry(page)).toEqual(OPEN);
  await page.touchscreen.tap(360, 420);
  await expect.poll(() => geometry(page)).toEqual(SHUT);
});

test("the menu button still opens it", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect.poll(() => geometry(page)).toEqual(OPEN);
});

test("a mostly vertical drag scrolls and leaves it shut", async ({ page }) => {
  const cdp = await open(page);
  await swipe(cdp, [150, 600], 200, 300);
  await page.waitForTimeout(400);
  expect(await geometry(page)).toEqual(SHUT);
});

test("a short, slow drag snaps back shut", async ({ page }) => {
  const cdp = await open(page);
  await swipe(cdp, [150, 420], 200);
  await page.waitForTimeout(400);
  expect(await geometry(page)).toEqual(SHUT);
});

test("a sideways scroller keeps the swipe until it is back at its start", async ({ page }) => {
  const cdp = await open(page);
  await page.evaluate(() => {
    const scroller = document.createElement("div");
    scroller.id = "probe-scroller";
    scroller.style.cssText =
      "position:fixed;left:0;right:0;top:300px;height:80px;overflow-x:auto;z-index:20";
    scroller.innerHTML = '<div style="width:1200px;height:80px"></div>';
    document.body.append(scroller);
    scroller.scrollLeft = 60;
  });
  await swipe(cdp, [60, 340], 260);
  await page.waitForTimeout(400);
  expect(await geometry(page)).toEqual(SHUT);
  expect(await page.evaluate(() => document.getElementById("probe-scroller")!.scrollLeft)).toBe(0);

  await swipe(cdp, [60, 340], 300);
  await expect.poll(() => geometry(page)).toEqual(OPEN);
});

test("an area that handles its own touch (touch-action: none) keeps the swipe", async ({
  page,
}) => {
  const cdp = await open(page);
  await page.evaluate(() => {
    const pan = document.createElement("div");
    pan.style.cssText =
      "position:fixed;left:0;right:0;top:300px;height:120px;touch-action:none;z-index:20";
    document.body.append(pan);
  });
  await swipe(cdp, [60, 360], 300);
  await page.waitForTimeout(400);
  expect(await geometry(page)).toEqual(SHUT);
});

test.describe("from 768px up", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("a swipe does nothing", async ({ page }) => {
    const cdp = await open(page);
    const before = await page.evaluate(() =>
      Math.round(document.querySelector("main")!.getBoundingClientRect().left),
    );
    await swipe(cdp, [400, 400], 700);
    await page.waitForTimeout(400);
    expect(
      await page.evaluate(() =>
        Math.round(document.querySelector("main")!.getBoundingClientRect().left),
      ),
    ).toBe(before);
  });
});
