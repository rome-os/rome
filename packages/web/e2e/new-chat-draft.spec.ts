import { expect, test, type Page } from "@playwright/test";

const INPUT = "[data-chat-composer-box] textarea";
const SESSION = "synthetic-draft-session";
const PROJECT = /^(Project|项目)$/;
declare global {
  interface Window {
    draftHarness: {
      creates: number;
      posts: string[];
      unexpectedWrites: string[];
      createCompleted: boolean;
      releaseCreate?: () => void;
      releasePost?: (accepted: boolean) => void;
    };
    originalDraftTextarea?: Element | null;
  }
}

/** Transport-level synthetic writes run before MSW, including multipart XHR. */
async function syntheticRequests(
  page: Page,
  options: { holdCreate?: boolean; rejectCreate?: boolean } = {},
) {
  await page.addInitScript(
    ({ sessionId, options }) => {
      const harness = (window.draftHarness = {
        creates: 0,
        posts: [] as string[],
        unexpectedWrites: [] as string[],
        createCompleted: false,
        releaseCreate: undefined as (() => void) | undefined,
        releasePost: undefined as ((accepted: boolean) => void) | undefined,
      });
      const turn = (body: FormData) => {
        const inputId = String(body.get("inputId"));
        harness.posts.push(inputId);
        return new Promise<Response>((resolve) => {
          harness.releasePost = (accepted) =>
            resolve(
              Response.json(
                accepted
                  ? { inputId, turnId: null, sessionId, disposition: "started" }
                  : { error: "Synthetic input rejection" },
                { status: accepted ? 200 : 500 },
              ),
            );
        });
      };
      const failClosed = (method: string, path: string): never => {
        harness.unexpectedWrites.push(method + " " + path);
        throw new Error("Unexpected synthetic-test write: " + method + " " + path);
      };
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const path = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
          location.origin,
        ).pathname;
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        if (path === "/api/chat/sessions" && method === "POST") {
          harness.creates++;
          if (options.rejectCreate)
            return Response.json({ error: "Synthetic create rejection" }, { status: 503 });
          if (options.holdCreate)
            await new Promise<void>((resolve) => {
              harness.releaseCreate = resolve;
            });
          harness.createCompleted = true;
          return Response.json({ id: sessionId });
        }
        if (path === "/api/chat/sessions" && method === "GET")
          return Response.json([
            {
              id: sessionId,
              name: "Synthetic draft session",
              projectPath: "default",
              createdAt: "2026-10-15T00:00:00.000Z",
              updatedAt: "2026-10-15T00:00:00.000Z",
            },
          ]);
        if (path === "/api/chat/sessions/" + sessionId && method === "GET")
          return Response.json({
            id: sessionId,
            name: "Synthetic draft session",
            projectPath: "default",
            agentName: null,
            archivedAt: null,
            pinnedAt: null,
          });
        if (path === "/api/chat/sessions/" + sessionId + "/messages" && method === "GET")
          return Response.json([]);
        if (path === "/api/chat/sessions/" + sessionId + "/turns") {
          if (method === "GET") return Response.json([]);
          if (method === "POST") return turn(init?.body as FormData);
        }
        // Rsbuild's lazy compiler POST is development tooling, not an API mutation.
        if (path === "/_rspack/lazy/trigger") return original(input, init);
        if (!["GET", "HEAD"].includes(method)) {
          if (
            path === "/api/settings" ||
            path === "/api/settings/guardian-timezone/detected" ||
            /\/api\/chat\/sessions\/[^/]+\/(read|layout)$/.test(path)
          )
            return Response.json({ success: true });
          return failClosed(method, path);
        }
        return original(input, init);
      };

      const open = XMLHttpRequest.prototype.open,
        send = XMLHttpRequest.prototype.send,
        abort = XMLHttpRequest.prototype.abort;
      const requests = new WeakMap<
        XMLHttpRequest,
        { method: string; path: string; cancelled: boolean }
      >();
      XMLHttpRequest.prototype.open = function (method, url, ...args) {
        requests.set(this, {
          method: method.toUpperCase(),
          path: new URL(String(url), location.origin).pathname,
          cancelled: false,
        });
        return Reflect.apply(open, this, [method, url, ...args]);
      } as typeof open;
      XMLHttpRequest.prototype.send = function (body) {
        const request = requests.get(this)!;
        if (["GET", "HEAD"].includes(request.method) || request.path === "/_rspack/lazy/trigger")
          return send.call(this, body);
        if (
          request.method !== "POST" ||
          request.path !== "/api/chat/sessions/" + sessionId + "/turns" ||
          !(body instanceof FormData)
        )
          return failClosed(request.method, request.path);
        this.upload.dispatchEvent(
          new ProgressEvent("progress", { lengthComputable: true, loaded: 1, total: 2 }),
        );
        void turn(body).then(async (response) => {
          if (request.cancelled) return;
          Object.defineProperty(this, "status", { configurable: true, value: response.status });
          Object.defineProperty(this, "responseText", {
            configurable: true,
            value: await response.text(),
          });
          this.upload.dispatchEvent(new ProgressEvent("load"));
          this.dispatchEvent(new ProgressEvent("load"));
        });
      };
      XMLHttpRequest.prototype.abort = function () {
        const request = requests.get(this);
        if (request && !["GET", "HEAD"].includes(request.method)) {
          request.cancelled = true;
          this.dispatchEvent(new ProgressEvent("abort"));
        } else abort.call(this);
      };
    },
    { sessionId: SESSION, options },
  );
}

async function newChatReady(page: Page) {
  await expect(page.locator(INPUT)).toBeVisible();
  await expect(page.getByRole("button", { name: PROJECT })).toBeVisible();
}
async function navigate(page: Page, path: string, state?: Record<string, string>) {
  const old = (await page.locator(INPUT).count())
    ? await page.locator(INPUT).elementHandle()
    : null;
  await page.evaluate(
    ({ path, state }) => {
      window.dispatchEvent(new CustomEvent("rome:host-navigate", { detail: { path, state } }));
    },
    { path, state },
  );
  if (path === "/settings") await expect(page).toHaveURL(/\/settings(?:\/|$)/);
  else await expect(page).toHaveURL(new URL(path, page.url()).href);
  if (path === "/settings") await expect(page.locator(INPUT)).toHaveCount(0);
  if (path === "/chat") {
    if (old) await expect.poll(() => old.evaluate((el) => el.isConnected)).toBe(false);
    await newChatReady(page);
  }
  if (path.startsWith("/chat/")) {
    await expect(page.locator(INPUT)).toBeVisible();
    await expect(page.getByRole("button", { name: PROJECT })).toHaveCount(0);
  }
}
async function shortcut(page: Page) {
  const old = (await page.locator(INPUT).count())
    ? await page.locator(INPUT).elementHandle()
    : null;
  const key = await page.evaluate(() =>
    navigator.platform.toUpperCase().includes("MAC") ? "Meta" : "Control",
  );
  await page.keyboard.press(key + "+Shift+O");
  await expect(page).toHaveURL(/\/chat$/);
  if (old) await expect.poll(() => old.evaluate((el) => el.isConnected)).toBe(false);
  await newChatReady(page);
}
async function endCaret(page: Page, raw: string) {
  await expect(page.locator(INPUT)).toHaveValue(raw);
  await expect
    .poll(() =>
      page
        .locator(INPUT)
        .evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
    )
    .toEqual([raw.length, raw.length]);
}
async function submit(page: Page) {
  if (await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches))
    await page.getByRole("button", { name: /^(Send|发送)/ }).click();
  else await page.locator(INPUT).press("Enter");
}
async function release(page: Page, accepted: boolean) {
  await page.evaluate((accepted) => window.draftHarness.releasePost!(accepted), accepted);
}
test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.draftHarness?.unexpectedWrites ?? [])).toEqual([]);
});

test("raw text/context survive real routes, shortcut and reload; attachments do not persist", async ({
  page,
}) => {
  await syntheticRequests(page);
  await page.goto("/chat");
  await newChatReady(page);
  await navigate(page, "/chat", {
    draft: "初始seed",
    skill: "synthetic_skill",
    projectPath: "/synthetic/project",
  });
  await endCaret(page, "初始seed");
  const projectLabel = await page.getByRole("button", { name: PROJECT }).textContent();
  const raw = "  中文🙂输入\n第二行\n  ";
  await page.locator(INPUT).fill(raw);
  await expect(page.locator(INPUT)).toHaveValue(raw);
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("fixture"),
  });
  await navigate(page, "/chat/" + SESSION);
  await navigate(page, "/chat");
  await endCaret(page, raw);
  await expect(page.getByRole("button", { name: PROJECT })).toHaveText(projectLabel!);
  await expect(page.getByText("synthetic.txt", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Remove skill|移除技能)$/ })).toBeVisible();
  const coarse = await page.evaluate(
    () => matchMedia("(hover: none) and (pointer: coarse)").matches,
  );
  if (coarse) {
    await expect(page.locator(INPUT)).not.toBeFocused();
    await page.locator(INPUT).focus();
  } else await expect(page.locator(INPUT)).toBeFocused();
  await page.keyboard.insertText("追加🙂");
  const appended = raw + "追加🙂";
  await expect(page.locator(INPUT)).toHaveValue(appended);
  await navigate(page, "/settings");
  await shortcut(page);
  await endCaret(page, appended);
  await shortcut(page);
  await endCaret(page, appended);
  await page.reload();
  await newChatReady(page);
  await endCaret(page, appended);
  await expect(page.getByRole("button", { name: PROJECT })).toHaveText(projectLabel!);
  await page.screenshot({ path: test.info().outputPath("restored.png") });
  await navigate(page, "/chat", { draft: "conflicting seed" });
  await expect(page.locator(INPUT)).toHaveValue(appended);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(INPUT).fill("");
  await expect(page.locator(INPUT)).toHaveValue("");
  await page.reload();
  await newChatReady(page);
  await expect(page.locator(INPUT)).toHaveValue("");
});

test("first send retains DOM/focus/optimistic row and navigates before acceptance; newer New chat survives", async ({
  page,
}) => {
  await syntheticRequests(page);
  await page.goto("/chat");
  await newChatReady(page);
  const raw = "  synthetic first send 中文  ";
  await page.locator(INPUT).fill(raw);
  await expect(page.locator(INPUT)).toHaveValue(raw);
  await page.locator(INPUT).focus();
  await page.evaluate((s) => {
    window.originalDraftTextarea = document.querySelector(s);
  }, INPUT);
  await submit(page);
  await expect(page).toHaveURL(new RegExp(SESSION));
  await expect
    .poll(() =>
      page.evaluate(
        (s) =>
          document.querySelector(s) === window.originalDraftTextarea &&
          document.activeElement === window.originalDraftTextarea,
        INPUT,
      ),
    )
    .toBe(true);
  await expect(page.getByText(/synthetic first send/).first()).toBeVisible();
  await expect(page.locator(INPUT)).toHaveValue("");
  await expect.poll(() => page.evaluate(() => window.draftHarness.posts.length)).toBe(1);
  if (!(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches)))
    await page.locator(INPUT).press("Enter");
  expect(await page.evaluate(() => window.draftHarness.creates)).toBe(1);
  await navigate(page, "/settings");
  await navigate(page, "/chat");
  await page.locator(INPUT).fill("newer draft");
  await expect(page.locator(INPUT)).toHaveValue("newer draft");
  await release(page, true);
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.locator(INPUT)).toHaveValue("newer draft");
  await navigate(page, "/chat/" + SESSION);
  await page.locator(INPUT).fill("session follow-up UNSENT");
  await expect(page.locator(INPUT)).toHaveValue("session follow-up UNSENT");
  await navigate(page, "/chat");
  await expect(page.locator(INPUT)).toHaveValue("newer draft");
});

test("late create after committed route departure never redirects or posts a turn", async ({
  page,
}) => {
  await syntheticRequests(page, { holdCreate: true });
  await page.goto("/chat");
  await newChatReady(page);
  await page.locator(INPUT).fill("old submission");
  await submit(page);
  await expect.poll(() => page.evaluate(() => !!window.draftHarness.releaseCreate)).toBe(true);
  await navigate(page, "/settings");
  await navigate(page, "/chat");
  await page.locator(INPUT).fill("new draft after remount");
  await expect(page.locator(INPUT)).toHaveValue("new draft after remount");
  await page.evaluate(() => window.draftHarness.releaseCreate!());
  await expect.poll(() => page.evaluate(() => window.draftHarness.createCompleted)).toBe(true);
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.locator(INPUT)).toHaveValue("new draft after remount");
  expect(await page.evaluate(() => window.draftHarness.posts.length)).toBe(0);
});

test("explicit rejected create restores exact raw input; deletion and old seed stay deleted", async ({
  page,
}) => {
  await syntheticRequests(page, { rejectCreate: true });
  await page.goto("/chat");
  await newChatReady(page);
  await navigate(page, "/chat", { draft: "old seeded text" });
  const raw = "  浏览器失败重试\n保留空白  ";
  await page.locator(INPUT).fill(raw);
  await expect(page.locator(INPUT)).toHaveValue(raw);
  await submit(page);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(INPUT)).toHaveValue(raw);
  await navigate(page, "/settings");
  await navigate(page, "/chat");
  await expect(page.locator(INPUT)).toHaveValue(raw);
  await page.locator(INPUT).fill("");
  await expect(page.locator(INPUT)).toHaveValue("");
  await page.reload();
  await newChatReady(page);
  await expect(page.locator(INPUT)).toHaveValue("");
});

test("attachment XHR acceptance releases locks for typing, adding files and another local send", async ({
  page,
}) => {
  await syntheticRequests(page);
  await page.goto("/chat");
  await newChatReady(page);
  const file = { name: "synthetic.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") };
  await page.locator(INPUT).fill("attachment raw");
  await page.locator('input[type="file"]').setInputFiles(file);
  await submit(page);
  await expect.poll(() => page.evaluate(() => window.draftHarness.posts.length)).toBe(1);
  await expect(page.getByRole("button", { name: /^(Cancel|取消)$/ })).toBeVisible();
  await release(page, true);
  await expect(page.locator(INPUT)).toBeEnabled();
  await expect(page.locator(INPUT)).toHaveValue("");
  await page.locator(INPUT).fill("after accepted");
  await expect(page.locator(INPUT)).toHaveValue("after accepted");
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("synthetic.txt", { exact: true })).toBeVisible();
  await submit(page);
  await expect.poll(() => page.evaluate(() => window.draftHarness.posts.length)).toBe(2);
  await release(page, true);
  await expect(page.locator(INPUT)).toHaveValue("");
  await expect(page.locator(INPUT)).toBeEnabled();
});

test("attachment cancellation remains local and retryable", async ({ page }) => {
  await syntheticRequests(page);
  await page.goto("/chat");
  await newChatReady(page);
  const raw = "  cancel raw 中文\n  ";
  await page.locator(INPUT).fill(raw);
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "cancel.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
  await submit(page);
  await expect.poll(() => page.evaluate(() => window.draftHarness.posts.length)).toBe(1);
  await page.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
  await expect(page.locator(INPUT)).toBeEnabled();
  await expect(page.locator(INPUT)).toHaveValue(raw);
  await expect(page.getByText("cancel.txt", { exact: true })).toBeVisible();
});

test("full-shell Tour alias reports ready and accepts parent typing", async ({ page }) => {
  await syntheticRequests(page);
  await page.goto("/settings");
  await expect(page.locator(INPUT)).toHaveCount(0);
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      if (event.data?.type === "rome:tour-composer-ready") document.body.dataset.tourReady = "true";
    });
    const frame = document.createElement("iframe");
    frame.id = "tour-frame";
    frame.src = "/chat?tour=chat";
    frame.width = "900";
    frame.height = "700";
    document.body.append(frame);
  });
  await expect(page.locator("body")).toHaveAttribute("data-tour-ready", "true");
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#tour-frame")!;
    frame.contentWindow!.postMessage(
      { type: "rome:tour-typing", active: true, progress: 0.4 },
      location.origin,
    );
  });
  await expect
    .poll(() => page.frameLocator("#tour-frame").locator(INPUT).inputValue())
    .not.toBe("");
});
