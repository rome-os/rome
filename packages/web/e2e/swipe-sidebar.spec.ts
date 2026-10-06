import { type CDPSession, expect, type Page, test } from "@playwright/test";

/**
 * On a phone a swipe right on the page drags the sidebar out and pushes it
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
  // The page's heading, not the mobile header: from 768px up there is none.
  // Its text is left alone, since a phone titles a settings section by name.
  await expect(page.locator("main h1")).toBeVisible({ timeout: 30_000 });
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

/**
 * Put a probe at the top of the page, inside the shell, and return a point at
 * its middle. With `shadow`, the probe is a host whose open shadow root holds
 * the markup, the way an app mounts.
 */
async function probe(page: Page, html: string, { shadow = false } = {}) {
  return page.evaluate(
    ({ html, shadow }) => {
      const main = document.querySelector("main")!;
      const host = document.createElement("div");
      host.id = "probe";
      if (shadow) host.attachShadow({ mode: "open" }).innerHTML = html;
      else host.innerHTML = html;
      main.prepend(host);
      window.scrollTo(0, 0);
      const root = shadow ? host.shadowRoot! : host;
      const scroller = root.querySelector<HTMLElement>("[data-scroll]");
      if (scroller) scroller.scrollLeft = 60;
      const box = host.getBoundingClientRect();
      return [Math.round(box.left + 60), Math.round(box.top + box.height / 2)] as [number, number];
    },
    { html, shadow },
  );
}

const SCROLLER =
  '<div data-scroll style="overflow-x:auto;height:80px"><div style="width:1200px;height:80px"></div></div>';

test("a sideways scroller keeps the swipe until it is back at its start", async ({ page }) => {
  const cdp = await open(page);
  const at = await probe(page, SCROLLER);
  await swipe(cdp, at, at[0] + 200);
  await page.waitForTimeout(400);
  expect(await geometry(page)).toEqual(SHUT);
  expect(
    await page.evaluate(
      () => document.querySelector<HTMLElement>("#probe [data-scroll]")!.scrollLeft,
    ),
  ).toBe(0);

  await swipe(cdp, at, at[0] + 240);
  await expect.poll(() => geometry(page)).toEqual(OPEN);
});

for (const [what, html] of [
  [
    "handles its own touch (touch-action: none)",
    '<div style="height:120px;touch-action:none"></div>',
  ],
  [
    "pans only up and down (touch-action: pan-y)",
    '<div style="height:120px;touch-action:pan-y"></div>',
  ],
  ["is editable (contenteditable)", '<div contenteditable style="height:120px"></div>'],
] as const) {
  test(`an area that ${what} keeps the swipe`, async ({ page }) => {
    const cdp = await open(page);
    const at = await probe(page, html);
    await swipe(cdp, at, at[0] + 240);
    await page.waitForTimeout(400);
    expect(await geometry(page)).toEqual(SHUT);
  });
}

// An app mounts in an open shadow root, so a listener outside it sees the
// host as the touch's target. What owns sideways movement inside still keeps
// the swipe.
for (const [what, html] of [
  ["a sideways scroller", SCROLLER],
  ["a touch-action: none canvas", '<div style="height:120px;touch-action:none"></div>'],
  ["a text field", '<input style="display:block;box-sizing:border-box;width:100%;height:120px" />'],
] as const) {
  test(`inside an app's shadow root, ${what} keeps the swipe`, async ({ page }) => {
    const cdp = await open(page);
    const at = await probe(page, html, { shadow: true });
    await swipe(cdp, at, at[0] + 240);
    await page.waitForTimeout(400);
    expect(await geometry(page)).toEqual(SHUT);
  });
}

test("inside an app's shadow root, plain content still swipes", async ({ page }) => {
  const cdp = await open(page);
  const at = await probe(page, '<div style="height:120px"></div>', { shadow: true });
  await swipe(cdp, at, at[0] + 240);
  await expect.poll(() => geometry(page)).toEqual(OPEN);
});

test("a sheet over the page, portaled to the body or fixed in it, keeps the swipe", async ({
  page,
}) => {
  const cdp = await open(page);
  // A bottom sheet or dialog, portaled to the body the way Radix mounts one.
  await page.evaluate(() => {
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:300px;z-index:60";
    document.body.append(sheet);
  });
  await swipe(cdp, [60, 700], 300);
  await page.waitForTimeout(400);
  expect(await geometry(page)).toEqual(SHUT);

  // A fixed overlay rendered inside the page, like the file browser's history.
  await page.evaluate(() => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;left:0;right:0;top:200px;height:200px;z-index:30";
    document.querySelector("main")!.append(overlay);
  });
  await swipe(cdp, [60, 300], 300);
  await page.waitForTimeout(400);
  expect(await geometry(page)).toEqual(SHUT);
});

test("a swipe back during the settle lands where the second swipe leaves it", async ({ page }) => {
  const cdp = await open(page);
  // The second swipe starts within the first one's 200ms settle.
  await swipe(cdp, [100, 420], 330);
  await swipe(cdp, [300, 420], 40);
  await expect.poll(() => geometry(page)).toEqual(SHUT);
  await page.waitForTimeout(400);
  expect(await geometry(page)).toEqual(SHUT);
  // And it hands the resting state back to the classes.
  expect(
    await page.evaluate(() =>
      ["aside", "main"].map(
        (selector) => document.querySelector<HTMLElement>(selector)!.style.translate,
      ),
    ),
  ).toEqual(["", ""]);
});

test("the page stays clipped while it slides back after a tap closes the sidebar", async ({
  page,
}) => {
  const cdp = await open(page);
  await swipe(cdp, [100, 420], 330);
  await expect.poll(() => geometry(page)).toEqual(OPEN);
  // Sample the document's sideways overflow every frame through the close.
  await page.evaluate(() => {
    const w = window as unknown as { maxOverflow: number };
    w.maxOverflow = 0;
    const until = performance.now() + 600;
    const sample = () => {
      const overflow =
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
        window.innerWidth;
      w.maxOverflow = Math.max(w.maxOverflow, overflow);
      if (performance.now() < until) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.touchscreen.tap(360, 420);
  await page.waitForTimeout(700);
  expect(await geometry(page)).toEqual(SHUT);
  expect(
    await page.evaluate(() => (window as unknown as { maxOverflow: number }).maxOverflow),
  ).toBe(0);
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
