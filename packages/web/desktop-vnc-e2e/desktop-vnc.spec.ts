import { expect, test, type BrowserContext, type Frame, type Page } from "@playwright/test";

const baseUrl = "http://localhost:3200";

const fakeRfbModule = `
class FakeRFB extends EventTarget {
  constructor(screen, wsUrl) {
    super();
    this.screen = screen;
    this.viewOnly = false;
    this.scaleViewport = false;
    this.clipViewport = false;
    this.dragViewport = false;
    this.resizeSession = false;
    this._sock = {};

    const probe = {
      wsUrl,
      focusCount: 0,
      clipboardPasteFrom: [],
      sendKey: [],
    };
    window.__desktopVncProbe = probe;
    window.__desktopVncRfb = this;

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 400;
    canvas.style.width = "640px";
    canvas.style.height = "400px";
    screen.append(canvas);

    queueMicrotask(() => this.dispatchEvent(new Event("connect")));
  }

  focus() {
    window.__desktopVncProbe.focusCount += 1;
    this.screen.focus();
  }

  clipboardPasteFrom(text) {
    window.__desktopVncProbe.clipboardPasteFrom.push(text);
    queueMicrotask(() => FakeRFB.messages.extendedClipboardProvide(this._sock, [1], [text]));
  }

  sendKey(keysym, code, down) {
    window.__desktopVncProbe.sendKey.push({
      keysym,
      code: code ?? null,
      down: down ?? null,
    });
  }
}

FakeRFB.messages = {
  extendedClipboardProvide() {},
};

export default FakeRFB;
`;

interface KeyCall {
  keysym: number;
  code: string | null;
  down: boolean | null;
}

interface RfbProbe {
  wsUrl: string;
  focusCount: number;
  clipboardPasteFrom: string[];
  sendKey: KeyCall[];
}

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/health") {
      return route.fulfill({ contentType: "application/json", body: '{"status":"ok"}' });
    }
    if (pathname === "/api/bootstrap") {
      return route.fulfill({ contentType: "application/json", body: '{"phase":"ready"}' });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.route("**/desktop-proxy/core/rfb.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: fakeRfbModule }),
  );
});

test("mounts the desktop client inside the actual /desktop iframe", async ({ page }) => {
  const { iframe, frame } = await openDesktopRoute(page);

  await expect(iframe).toHaveAttribute("allow", "clipboard-read; clipboard-write");
  await expect
    .poll(() => readProbe(frame))
    .toEqual(
      expect.objectContaining({
        wsUrl: "ws://localhost:3200/desktop-proxy/websockify",
      }),
    );
});

test("keeps a pasted tab from becoming a remote Tab key", async ({ page }) => {
  const { frame } = await openDesktopRoute(page);
  await pasteViaShortcut(page, frame, "left\tright");

  const probe = await readProbe(frame);
  expect(probe.clipboardPasteFrom).toEqual(["left\tright"]);
  expect(probe.sendKey).not.toContainEqual({ keysym: 0xff09, code: "Tab", down: null });
  expect(probe.sendKey).toEqual(expect.arrayContaining(remotePasteShortcutCalls));
});

test("keeps a pasted newline from becoming a remote Enter key", async ({ page }) => {
  const { frame } = await openDesktopRoute(page);
  await pasteViaShortcut(page, frame, "line1\nline2");

  const probe = await readProbe(frame);
  expect(probe.clipboardPasteFrom).toEqual(["line1\nline2"]);
  expect(probe.sendKey).not.toContainEqual({ keysym: 0xff0d, code: "Enter", down: null });
  expect(probe.sendKey).toEqual(expect.arrayContaining(remotePasteShortcutCalls));
});

test("sends simple Chinese and emoji through the remote clipboard", async ({ page }) => {
  const { frame } = await openDesktopRoute(page);
  const payload = "输入测试🌱☀️";
  await pasteViaShortcut(page, frame, payload);

  const probe = await readProbe(frame);
  expect(probe.clipboardPasteFrom).toEqual([payload]);
  expect(probe.sendKey).toEqual(expect.arrayContaining(remotePasteShortcutCalls));
  expect(probe.sendKey).not.toEqual(
    expect.arrayContaining([...payload].map((character) => keyCall(keysymFor(character)))),
  );
});

test("keeps every code point in composed emoji paste calls", async ({ page }) => {
  const { frame } = await openDesktopRoute(page);
  const payload = "🌱☀️🍂❄️🐈‍⬛🐻‍❄️1️⃣";
  await pasteViaShortcut(page, frame, payload);

  const probe = await readProbe(frame);
  expect(probe.clipboardPasteFrom).toEqual([payload]);
  expect(probe.sendKey).toEqual(expect.arrayContaining(remotePasteShortcutCalls));
});

test("handles a macOS paste chord without standalone Meta events", async ({ page }) => {
  const { frame } = await openDesktopRoute(page);
  const payload = "春夏秋冬🌱☀️🍂❄️";
  await focusDesktop(frame);
  await page.evaluate((value) => navigator.clipboard.writeText(value), payload);

  await frame.locator("#screen").evaluate((screen) => {
    screen.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "v",
        code: "KeyV",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    screen.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "v",
        code: "KeyV",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect
    .poll(() => readProbe(frame))
    .toEqual(expect.objectContaining({ clipboardPasteFrom: [payload] }));
});

test("maps a macOS shortcut without standalone Meta events", async ({ page }) => {
  const { frame } = await openDesktopRoute(page);
  await focusDesktop(frame);

  await frame.locator("#screen").evaluate((screen) => {
    for (const type of ["keydown", "keyup"]) {
      screen.dispatchEvent(
        new KeyboardEvent(type, {
          key: "a",
          code: "KeyA",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });

  expect((await readProbe(frame)).sendKey).toEqual([
    { keysym: 0xffe3, code: "ControlLeft", down: true },
    { keysym: 0xffe3, code: "ControlLeft", down: false },
  ]);
});

test("sends Chinese and emoji through the touch keyboard input path", async ({ page }) => {
  await page.goto("/desktop-vnc.html?touch=1&resize=scale&path=desktop-proxy/websockify");
  const frame = page.mainFrame();
  await waitForFakeRfb(frame);
  await expect(frame.locator("#kb-toggle")).toBeVisible();

  const payload = "输入测试🌱☀️";
  await frame.locator("#kb-toggle").click();
  await frame.locator("#keyboard-input").evaluate((input, text) => {
    input.value = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }, payload);

  await expect
    .poll(() => readProbe(frame))
    .toEqual(
      expect.objectContaining({
        clipboardPasteFrom: [payload],
        sendKey: expect.arrayContaining(remotePasteShortcutCalls),
      }),
    );
});

test("writes a remote Unicode clipboard event into the browser clipboard", async ({ page }) => {
  const { frame } = await openDesktopRoute(page);
  const payload = "远端复制🌱☀️🐈‍⬛";
  await page.evaluate(() => navigator.clipboard.writeText(""));

  await frame.evaluate((text) => {
    const rfb = (
      window as typeof window & {
        __desktopVncRfb: EventTarget;
      }
    ).__desktopVncRfb;
    rfb.dispatchEvent(new CustomEvent("clipboard", { detail: { text } }));
  }, payload);

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 3_000 })
    .toBe(payload);
});

test("cancels a pending paste after focus leaves the iframe", async ({ page }) => {
  const { frame } = await openDesktopRoute(page);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Outer focus target");
    input.style.cssText = "position:fixed;inset:0 auto auto 0;z-index:9999";
    document.body.append(input);
  });

  await focusDesktop(frame);
  await page.evaluate(() => navigator.clipboard.writeText("STALE_PASTE"));
  await page.keyboard.down("Control");
  await page.keyboard.down("v");
  await page.keyboard.up("v");
  await page.getByLabel("Outer focus target").click();
  await page.keyboard.up("Control");
  expect((await readProbe(frame)).clipboardPasteFrom).toEqual([]);

  await focusDesktop(frame);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");

  const probe = await readProbe(frame);
  expect(probe.focusCount).toBeGreaterThan(0);
  expect(probe.clipboardPasteFrom).toEqual([]);
});

async function openDesktopRoute(page: Page) {
  await page.goto("/desktop");
  const iframe = page.locator('iframe[src^="/desktop-vnc.html"]');
  await expect(iframe).toBeVisible({ timeout: 15_000 });
  const frame = await iframe.elementHandle().then((element) => element?.contentFrame());
  if (!frame) throw new Error("desktop iframe did not load");
  await waitForFakeRfb(frame);
  return { iframe, frame };
}

async function waitForFakeRfb(frame: Frame) {
  await expect(frame.locator("#screen canvas")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => readProbe(frame))
    .toEqual(expect.objectContaining({ focusCount: expect.any(Number) }));
}

async function pasteViaShortcut(page: Page, frame: Frame, text: string) {
  await focusDesktop(frame);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.down("Control");
  await page.keyboard.down("v");
  await page.keyboard.up("v");
  await page.keyboard.up("Control");

  await expect
    .poll(() => readProbe(frame))
    .toEqual(expect.objectContaining({ clipboardPasteFrom: [text] }));
}

async function focusDesktop(frame: Frame) {
  await frame.locator("#screen").click();
}

async function readProbe(frame: Frame): Promise<RfbProbe> {
  return frame.evaluate(() => {
    const probe = (
      window as typeof window & {
        __desktopVncProbe?: RfbProbe;
      }
    ).__desktopVncProbe;
    if (!probe) throw new Error("FakeRFB did not initialize");
    return probe;
  });
}

function keysymFor(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) throw new Error("character has no code point");
  return codePoint <= 0xff ? codePoint : 0x01000000 | codePoint;
}

function keyCall(keysym: number): KeyCall {
  return { keysym, code: null, down: null };
}

const remotePasteShortcutCalls: KeyCall[] = [
  { keysym: 0xffe3, code: "ControlLeft", down: true },
  { keysym: 0x76, code: "KeyV", down: true },
  { keysym: 0x76, code: "KeyV", down: false },
  { keysym: 0xffe3, code: "ControlLeft", down: false },
];
