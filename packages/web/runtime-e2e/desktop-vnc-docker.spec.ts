import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type BrowserContext, type Frame, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.ROME_NOVNC_BASE_URL ?? "http://main.rome.localhost:3000";
const chromeContainer = process.env.ROME_NOVNC_CONTAINER ?? "main-chrome-1";
const restartSidecar = process.env.ROME_NOVNC_RESTART_SIDECAR !== "0";
const longUnicodePayload = `${"春夏秋冬".repeat(10)}${"🌱☀️🍂❄️".repeat(10)}`;

const remoteProbeHtml = `<!doctype html>
<meta charset="utf-8">
<title>Rome noVNC input probe</title>
<textarea id="a" autofocus></textarea>
<form id="form"><input id="b"></form>
<script>
  window.submits = [];
  window.events = [];
  for (const type of ["keydown", "keyup", "copy", "paste", "beforeinput", "input"]) {
    document.addEventListener(type, (event) => {
      window.events.push({
        type: event.type,
        key: event.key,
        data: event.data,
        inputType: event.inputType,
        target: event.target.id,
      });
      window.events = window.events.slice(-80);
    }, true);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    window.submits.push(b.value);
  });
  window.resetProbe = (target = "a") => {
    a.value = "";
    b.value = "";
    window.submits = [];
    window.events = [];
    document.getElementById(target).focus();
  };
  window.probeState = () => ({
    a: a.value,
    b: b.value,
    focus: document.activeElement.id,
    selection: [a.selectionStart, a.selectionEnd],
    submits: window.submits,
    events: window.events,
  });
</script>`;

const remoteCdpScript = String.raw`
import base64
import json
import sys
import urllib.request
import websocket

target_id = sys.argv[1]
payload = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8"))
pages = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json"))
page = next(item for item in pages if item.get("id") == target_id)
socket = websocket.create_connection(page["webSocketDebuggerUrl"])
socket.send(json.dumps({"id": 1, "method": payload["method"], "params": payload.get("params", {})}))
while True:
    response = json.loads(socket.recv())
    if response.get("id") == 1:
        break
socket.close()
if "error" in response:
    raise RuntimeError(response["error"])
print(json.dumps(response.get("result", {}), ensure_ascii=False))
`;

const createRemoteTabScript = String.raw`
import json
import sys
import urllib.parse
import urllib.request

url = sys.argv[1]
request = urllib.request.Request(
    "http://127.0.0.1:9222/json/new?" + urllib.parse.quote(url, safe=""),
    method="PUT",
)
print(json.load(urllib.request.urlopen(request))["id"])
`;

let context: BrowserContext;
let page: Page;
let desktopFrame: Frame;
let remoteTargetId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await ensureSidecarIsReady();
  remoteTargetId = await createRemoteProbeTab();

  context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(baseUrl).origin,
  });
  page = await context.newPage();
  await openStandaloneDesktop();
});

test.afterAll(async () => {
  if (remoteTargetId) {
    await remoteCdp("Page.close").catch(() => {});
  }
  await context?.close();
});

test("keeps a pasted tab in the focused remote field", async () => {
  await pasteThroughRome("left\tright", "a");
  await expectRemoteState({
    a: "left\tright",
    b: "",
    focus: "a",
    submits: [],
  });
});

test("does not submit a remote form when pasted text contains a newline", async () => {
  await pasteThroughRome("line1\nline2", "b");
  await expectRemoteState({
    a: "",
    b: "line1 line2",
    focus: "b",
    submits: [],
  });
});

test("pastes simple Chinese and emoji without corruption", async () => {
  const payload = "输入测试🌱☀️";
  await pasteThroughRome(payload, "a");

  await expectRemoteState({ a: payload, b: "", focus: "a", submits: [] });
});

test("types simple Chinese and emoji through the touch keyboard input path", async () => {
  const payload = "输入测试🌱☀️";
  await openStandaloneDesktop("touch=1&resize=scale&path=desktop-proxy/websockify");
  await focusRemoteTarget("a");
  await desktopFrame.locator("#kb-toggle").click();
  await desktopFrame.locator("#keyboard-input").evaluate((input, text) => {
    input.value = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }, payload);

  await expectRemoteState({ a: payload, b: "", focus: "a", submits: [] });
  await openStandaloneDesktop();
});

test("copies remote ASCII into the browser clipboard", async () => {
  await copyRemoteSelection("COPY_ASCII_123");

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 3_000 })
    .toBe("COPY_ASCII_123");
});

test("copies remote Chinese and emoji into the browser clipboard", async () => {
  const payload = "复制测试🌱☀️";
  await copyRemoteSelection(payload);

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 3_000 })
    .toBe(payload);
});

async function copyRemoteSelection(payload: string) {
  await focusRemoteTarget("a");
  await remoteEval(`a.value = ${JSON.stringify(payload)}; a.select();`);

  await page.keyboard.down("Control");
  await page.keyboard.press("c");
  await page.keyboard.up("Control");

  await expect.poll(readRemoteState, { timeout: 3_000 }).toEqual(
    expect.objectContaining({
      events: expect.arrayContaining([expect.objectContaining({ type: "copy", target: "a" })]),
    }),
  );
}

test("pastes a long Chinese and emoji payload without truncation", async () => {
  await pasteThroughRome(longUnicodePayload, "a");
  await expectRemoteEvent({ type: "input", target: "a" });

  await expectRemoteState({ a: longUnicodePayload, b: "", focus: "a", submits: [] });
});

test("continues accepting new Chinese and emoji after a long Unicode paste", async () => {
  await pasteThroughRome(longUnicodePayload, "a");
  await expectRemoteEvent({ type: "input", target: "a" });
  const payload = "春夏秋冬🌱☀️🍂❄️";
  await pasteThroughRome(payload, "a");

  await expectRemoteState({ a: payload, b: "", focus: "a", submits: [] });
});

test("preserves complex Unicode when only the RFB clipboard channel is used", async () => {
  const payload = "剪贴板测试🌱☀️🍂❄️🐈‍⬛🐻‍❄️";
  await focusRemoteTarget("a");
  await page.keyboard.press("Shift");
  await page.evaluate((text) => {
    const activeRfb = (
      window as typeof window & {
        __romeActiveRfb?: { clipboardPasteFrom(value: string): void };
      }
    ).__romeActiveRfb;
    if (!activeRfb) throw new Error("noVNC RFB instance was not captured");
    activeRfb.clipboardPasteFrom(text);
  }, payload);
  await page.waitForTimeout(500);

  await remotePasteShortcut();
  await expect.poll(readRemoteState, { timeout: 3_000 }).toEqual(
    expect.objectContaining({
      events: expect.arrayContaining([expect.objectContaining({ type: "paste", target: "a" })]),
    }),
  );
  await expectRemoteState({ a: payload, b: "", focus: "a", submits: [] });
});

test("maps macOS Command+A to remote select-all", async () => {
  await focusRemoteTarget("a");
  await remoteEval(`a.value = "select-me"; a.focus(); a.setSelectionRange(9, 9);`);

  await page.keyboard.down("Meta");
  await page.keyboard.press("a");
  await page.keyboard.up("Meta");
  await page.keyboard.type("x");

  await expectRemoteState({ a: "x", b: "", focus: "a", submits: [] });
});

test("cancels a pending paste when focus leaves the desktop iframe", async () => {
  await page.setContent(`
    <input id="outer-focus" aria-label="Outer focus target">
    <iframe
      title="Rome Desktop"
      src="/desktop-vnc.html?resize=scale&path=desktop-proxy/websockify"
      allow="clipboard-read; clipboard-write"
      style="width: 1000px; height: 700px"
    ></iframe>
  `);
  desktopFrame = await waitForDesktopFrame();
  await installRfbCapture(desktopFrame);

  const canvas = desktopFrame.locator("#screen canvas");
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await canvas.click();
  await remoteCdp("Page.bringToFront");
  await remoteEval(`window.resetProbe("a")`);
  await page.evaluate(() => navigator.clipboard.writeText("STALE_PASTE"));

  await page.keyboard.down("Control");
  await page.keyboard.down("v");
  await page.keyboard.up("v");
  await page.getByLabel("Outer focus target").click();
  await page.keyboard.up("Control");

  await canvas.click();
  await remoteEval(`a.value = "newtext"; a.focus(); a.setSelectionRange(7, 7);`);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await expectRemoteEvent({ type: "keydown", key: "a", target: "a" });

  await expectRemoteState({ a: "newtext", b: "", focus: "a", submits: [] });
});

async function openStandaloneDesktop(query = "resize=scale&path=desktop-proxy/websockify") {
  await page.goto(`${baseUrl}/desktop-vnc.html?${query}`);
  desktopFrame = page.mainFrame();
  await installRfbCapture(desktopFrame);
  await expect(page.locator("#screen canvas")).toBeVisible({ timeout: 15_000 });
  await page.locator("#screen canvas").click();
  await remoteCdp("Page.bringToFront");
  await remoteEval(`window.resetProbe("a")`);
}

async function waitForDesktopFrame() {
  const iframe = page.locator('iframe[src^="/desktop-vnc.html"]');
  await expect(iframe).toBeVisible({ timeout: 15_000 });
  const frame = await iframe.elementHandle().then((element) => element?.contentFrame());
  if (!frame) throw new Error("desktop iframe did not load");
  return frame;
}

async function installRfbCapture(frame: Frame) {
  await frame.evaluate(async () => {
    const rfbModule = await window.eval("import('/desktop-proxy/core/rfb.js')");
    const prototype = rfbModule.default.prototype;
    if (prototype.__romeCaptureInstalled) return;
    const clipboardPasteFrom = prototype.clipboardPasteFrom;
    prototype.clipboardPasteFrom = function (this: unknown, text: string) {
      (
        window as typeof window & {
          __romeActiveRfb?: unknown;
        }
      ).__romeActiveRfb = this;
      return clipboardPasteFrom.call(this, text);
    };
    const sendKey = prototype.sendKey;
    prototype.sendKey = function (this: unknown, ...args: unknown[]) {
      (
        window as typeof window & {
          __romeActiveRfb?: unknown;
        }
      ).__romeActiveRfb = this;
      return Reflect.apply(sendKey, this, args);
    };
    prototype.__romeCaptureInstalled = true;
  });
}

async function pasteThroughRome(text: string, target: "a" | "b") {
  await focusRemoteTarget(target);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);

  await page.keyboard.down("Control");
  await page.keyboard.down("v");
  await page.keyboard.up("v");
  await page.keyboard.up("Control");
  await page.waitForTimeout(750);
}

async function focusRemoteTarget(target: "a" | "b") {
  const canvas = desktopFrame.locator("#screen canvas");
  await canvas.click();
  await remoteCdp("Page.bringToFront");
  await remoteEval(`window.resetProbe(${JSON.stringify(target)})`);
}

async function expectRemoteState(expected: {
  a: string;
  b: string;
  focus: string;
  submits: string[];
}) {
  await expect.poll(readRemoteState, { timeout: 3_000 }).toEqual(expect.objectContaining(expected));
}

async function expectRemoteEvent(expected: { type: string; target: string; key?: string }) {
  await expect.poll(readRemoteState, { timeout: 3_000 }).toEqual(
    expect.objectContaining({
      events: expect.arrayContaining([expect.objectContaining(expected)]),
    }),
  );
}

async function readRemoteState() {
  const value = await remoteEval(`JSON.stringify(window.probeState())`);
  return JSON.parse(String(value));
}

async function remotePasteShortcut() {
  const events = [
    {
      type: "keyDown",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      modifiers: 2,
    },
    {
      type: "keyDown",
      key: "v",
      code: "KeyV",
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: 2,
    },
    {
      type: "keyUp",
      key: "v",
      code: "KeyV",
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: 2,
    },
    {
      type: "keyUp",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      modifiers: 0,
    },
  ];

  for (const event of events) {
    await remoteCdp("Input.dispatchKeyEvent", event);
  }
}

async function remoteEval(expression: string) {
  const result = await remoteCdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const evaluation = result as { exceptionDetails?: unknown; result?: { value?: unknown } };
  if (evaluation.exceptionDetails) {
    throw new Error(`remote evaluation failed: ${JSON.stringify(evaluation.exceptionDetails)}`);
  }
  return evaluation.result?.value;
}

async function remoteCdp(method: string, params: Record<string, unknown> = {}) {
  const payload = Buffer.from(JSON.stringify({ method, params })).toString("base64");
  const { stdout } = await runDocker([
    "exec",
    chromeContainer,
    "python3",
    "-c",
    remoteCdpScript,
    remoteTargetId,
    payload,
  ]);
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

async function createRemoteProbeTab() {
  const probeUrl = `data:text/html;charset=utf-8,${encodeURIComponent(remoteProbeHtml)}`;
  const { stdout } = await runDocker([
    "exec",
    chromeContainer,
    "python3",
    "-c",
    createRemoteTabScript,
    probeUrl,
  ]);
  return stdout.trim();
}

async function ensureSidecarIsReady() {
  await runDocker(["inspect", chromeContainer]);
  if (restartSidecar) {
    await stopVirtualDisplayGracefully();
    await runDocker(["restart", chromeContainer]);
  }

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await runDocker([
        "exec",
        chromeContainer,
        "sh",
        "-lc",
        "curl -fsS http://127.0.0.1:9222/json/version >/dev/null",
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Chrome CDP did not become ready in ${chromeContainer}`);
}

async function stopVirtualDisplayGracefully() {
  await runDocker([
    "exec",
    chromeContainer,
    "sh",
    "-lc",
    'pid=$(pgrep -f \'^(Xtigervnc|Xvfb) :99 \' | head -n 1); if [ -n "$pid" ]; then kill -TERM "$pid"; for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.1; done; fi',
  ]).catch(() => {});
}

async function runDocker(args: string[]) {
  const result = await execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}
