import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineNode, z } from "@midscene/test";
import type { NodeExecutionContext } from "@midscene/test";
import { defineProjectSetup, defineTestProject } from "@midscene/test/config";
import { createMidsceneNodes } from "@midscene/test/midscene";
import { PlaywrightAgent } from "@midscene/web/playwright/agent";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

loadEnv({ path: fileURLToPath(new URL(".env", import.meta.url)) });

const BASE_URL = process.env.ROME_E2E_BASE_URL ?? "http://localhost:3200";
const BASE_ORIGIN = new URL(BASE_URL).origin;
// The mock app boots with an English UI when no language is cached, but Chinese
// CI runners would detect zh-CN from the OS. Pin English explicitly so every
// assertion in the YAML cases targets one language.
const LOCALE = "en";

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

interface ProjectContext {
  browser: Browser;
  browserContext?: BrowserContext;
  page?: Page;
  agent?: PlaywrightAgent;
  apiResponses?: Array<{ method: string; path: string; status: number; requestBody: string }>;
}

const AI_ACT_CONTEXT = `
When returning pixel coordinates, keep every coordinate strictly inside the screenshot bounds:
never use the screenshot width or height itself as a right or bottom coordinate. Prefer a tight
box around the interactive content instead of the full container or viewport edge. Coordinates
must be absolute from the full screenshot's top-left corner; include the left sidebar, headers, and
all surrounding workspace offsets instead of resetting the origin at the main content area. Text-field
coordinates must tightly enclose the editable line or placeholder text, not the larger rounded
composer surrounding it. Text-field focus often has no visible indicator; after one accurate
locate, proceed with Input or ClearInput instead of repeatedly tapping while waiting for a visual
focus change.
`.trim();

const getAgent = ({ context }: NodeExecutionContext<unknown, ProjectContext>) => {
  if (!context.page) throw new Error("No page is open; call app.open before AI steps");
  context.agent ??= new PlaywrightAgent(context.page, {
    aiContexts: { aiAct: AI_ACT_CONTEXT },
  });
  return context.agent;
};

const setup = defineProjectSetup<ProjectContext>({
  name: "web",
  async setup({ env, onTeardown }) {
    const browser = await chromium.launch({ headless: env.HEADLESS !== "false" });
    const context: ProjectContext = { browser };
    onTeardown(async () => {
      await context.agent?.destroy();
      await context.browserContext?.close().catch(() => undefined);
      await browser.close();
    });
    return context;
  },
});

// The mock user starts with only Apps/Chat/Projects pinned. Product stories
// cross between pages through the sidebar, so pin every built-in destination
// up front (rome-sidebar-pins, the shell's own localStorage contract). This
// also avoids the "all apps" popover and keeps clicks deterministic.
const DEFAULT_PINS = [
  "apps",
  "projects",
  "sessions",
  "memory",
  "people",
  "routines",
  "activity",
  "desktop",
  "chat",
  "settings",
] as const;

const openInput = z.strictObject({
  path: z.string().min(1),
  // 'shell' waits for the authenticated sidebar (mock guardian), 'login' for
  // the login route, and 'any' only waits for the document to load.
  waitUntil: z.enum(["shell", "login", "any"]).default("shell"),
  // Extra built-in nav ids to pin in addition to the default set.
  pins: z.array(z.string()).optional(),
  // 'mobile' opens a phone-sized viewport (sidebar becomes a drawer).
  viewport: z.enum(["desktop", "mobile"]).default("desktop"),
});

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

const appOpen = defineNode<typeof openInput, void, ProjectContext>({
  name: "app.open",
  description:
    "Open a Rome route in a fresh browser context. A fresh context also resets " +
    "the in-memory MSW mock state, so every case starts from the same fixtures.",
  inputSchema: openInput,
  async execute({ context, input }) {
    // Tear down the previous case's page/agent before creating the new context.
    await context.agent?.destroy().catch(() => undefined);
    context.agent = undefined;
    await context.browserContext?.close().catch(() => undefined);

    const browserContext = await context.browser.newContext({
      viewport: VIEWPORTS[input.viewport],
      locale: "en-US",
      // Fixtures encode absolute instants (e.g. Stock Daily's
      // 2026-09-15T20:30:00Z, asserted as "09/16, 04:30 AM"). GitHub's hosted
      // runners run in UTC and a developer's laptop may run in any zone, so a
      // host-dependent zone would reformat those timestamps differently. Pin
      // the zone in which every case is authored; the wall clock is left real
      // because mock timestamps are generated as offsets from now (freezing
      // Date in the page would mislabel the Today/Yesterday grouping).
      timezoneId: "Asia/Shanghai",
      // The copy-message control only swaps to its "Copied" confirmation once
      // navigator.clipboard.writeText resolves; grant it explicitly so the
      // feedback is deterministic under headless CI.
      permissions: ["clipboard-read", "clipboard-write"],
    });
    // The suite promises an offline/local mock boundary. Abort browser traffic
    // to every other origin so a recorded app cannot silently add a CDN or
    // third-party dependency. Model calls are made by the Node-side agent and
    // are therefore outside this browser request guard.
    await browserContext.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (new URL(requestUrl).origin === BASE_ORIGIN) {
        await route.continue();
        return;
      }
      await route.abort("blockedbyclient");
    });
    // Pin the i18n language and sidebar entries before the app bundle runs.
    const pins = [...DEFAULT_PINS, ...(input.pins ?? [])].map((id) => ({
      type: "builtin" as const,
      id,
    }));
    await browserContext.addInitScript(
      ({ lang, sidebarPins }) => {
        // Seed defaults only when the app has not stored a value: cases run
        // in a fresh context start in English with every built-in pinned,
        // but a case that switches the language (or edits pins) keeps its
        // choice across in-context navigations instead of being reset here.
        if (!window.localStorage.getItem("rome.lang")) {
          window.localStorage.setItem("rome.lang", lang);
        }
        if (!window.localStorage.getItem("rome-sidebar-pins")) {
          window.localStorage.setItem("rome-sidebar-pins", JSON.stringify(sidebarPins));
        }
      },
      { lang: LOCALE, sidebarPins: pins },
    );
    const page = await browserContext.newPage();
    context.browserContext = browserContext;
    context.page = page;
    context.apiResponses = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== BASE_ORIGIN || !url.pathname.startsWith("/api/")) return;
      context.apiResponses?.push({
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
        requestBody: response.request().postData() ?? "",
      });
    });

    const url = input.path.startsWith("http")
      ? input.path
      : `${BASE_URL}${input.path.startsWith("/") ? "" : "/"}${input.path}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (input.waitUntil === "shell") {
      // The authenticated sidebar only renders after MSW answers /api/health,
      // /api/bootstrap and /api/auth/me, so this doubles as the mock-ready wait.
      await page.locator('a[href="/chat"]').first().waitFor({
        state: "visible",
        timeout: 60_000,
      });
    } else if (input.waitUntil === "login") {
      await page.waitForURL(/\/login/, { timeout: 60_000 });
      // The URL matches immediately after domcontentloaded; wait until the
      // LoginPage bundle has actually mounted the form.
      await page.locator('input[type="password"]').first().waitFor({
        state: "visible",
        timeout: 60_000,
      });
    }
  },
});

const scrollTextInput = z.strictObject({
  text: z.string().min(1),
});

const appScrollTextIntoView = defineNode<typeof scrollTextInput, void, ProjectContext>({
  name: "app.scrollTextIntoView",
  description:
    "Scroll the nearest scrollable ancestor so the element whose visible " +
    "text contains the given string is centered in the viewport. Unlike " +
    "scrolling to an absolute position, this survives late layout shifts " +
    "(e.g. mermaid diagrams re-rendering).",
  inputSchema: scrollTextInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    // The chat's stick-to-bottom hook ignores programmatic scrolls and snaps
    // back on every content resize (streamed blocks, mermaid). Only a trusted
    // wheel gesture releases the pin, so emulate one over the transcript
    // before positioning.
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, -4000);
    await page.waitForTimeout(350);
    // getByText pierces open shadow roots, so this also positions content
    // inside recorded apps.
    const target = page.getByText(input.text, { exact: false }).last();
    await target.waitFor({ state: "visible", timeout: 30_000 });
    await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(500);
  },
});

const clickByLabelInput = z.strictObject({
  // Substring of the control's accessible name (aria-label / aria-labelledby
  // / inner text). The role engine matches across open shadow roots.
  label: z.string().min(1),
  // Match the accessible name exactly instead of as a substring. Needed for
  // short labels like "Running" that otherwise match "Running 1" counters.
  exact: z.boolean().default(false),
  // When several visible controls share the name (e.g. a question card's
  // "Send" above the composer's "Send"), which one to click in DOM order
  // (0-based). Defaults to the first.
  index: z.number().int().min(0).default(0),
});

const appClickByLabel = defineNode<typeof clickByLabelInput, void, ProjectContext>({
  name: "app.clickByLabel",
  description:
    "Click an icon-only or ambiguously placed control by its accessible name " +
    "(aria-label or inner text), deterministically. Use this instead of aiTap " +
    "for tile kebab menus, repeated icon buttons, and short-text filter chips " +
    "where a visual tap could hit the wrong element. Also matches settings " +
    "sub-navigation <a> links (e.g. jump from Advanced back to Connections) " +
    'and plain <summary> disclosure headings such as "Developer Settings". ' +
    "Works inside open shadow roots. Set exact:true when the label is short " +
    '(e.g. "Running" must not match a "Running 1" counter), and index to ' +
    'disambiguate repeated names such as a composer "Send" that shares the ' +
    'page with a question-card "Send".',
  inputSchema: clickByLabelInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const escaped = input.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = input.exact ? new RegExp(`^${escaped}$`, "i") : new RegExp(escaped, "i");
    const lists = [
      page.getByRole("button", { name: pattern, exact: input.exact }),
      // Settings sub-navigation renders <a href="/settings/..."> entries
      // (e.g. jumping from Advanced back to Connections).
      page.getByRole("link", { name: pattern, exact: input.exact }),
      // Segmented controls render <button role="radio"> (timeline channel
      // filters), whose accessible role is "radio", not "button".
      page.getByRole("radio", { name: pattern, exact: input.exact }),
      // Collapsible disclosures like "Developer Settings" are plain
      // <summary> elements with no role/aria-label.
      page.locator("summary", { hasText: pattern }),
      page.locator(`[aria-label*="${input.label}" i]`),
    ];
    for (const list of lists) {
      const count = await list.count();
      if (count <= input.index) continue;
      const target = list.nth(input.index);
      if (await target.isVisible().catch(() => false)) {
        await target.click({ timeout: 15_000 });
        await page.waitForTimeout(300);
        return;
      }
    }
    throw new Error(
      `app.clickByLabel: no visible control labelled "${input.label}" at index ${input.index}`,
    );
  },
});

const expectTextsInput = z.strictObject({
  // Every string must appear in the scoped element's visible text (case
  // insensitive). Use for long cards/transcripts whose full contents extend
  // beyond one screenshot, so a vision assertion can only see part of them.
  all: z.array(z.string().min(1)).default([]),
  // None of the strings may appear.
  none: z.array(z.string().min(1)).default([]),
  // Each entry is a case-insensitive regular expression that must match the
  // visible text — use for date-dependent text that must not pin a month,
  // e.g. a calendar heading /(January|…|December) 20\\d\\d/.
  matches: z.array(z.string().min(1)).default([]),
  // Where to read text: the <main> content (default) or the whole document
  // body. "body" is required for toasts, which sonner renders in a portal
  // outside <main> and auto-dismisses after a few seconds.
  scope: z.enum(["main", "body"]).default("main"),
});

const appExpectTexts = defineNode<typeof expectTextsInput, void, ProjectContext>({
  name: "app.expectTexts",
  description:
    "Assert that text contains (or does not contain) the given strings, " +
    "deterministically via the DOM instead of a screenshot. Use for long " +
    "cards or transcripts whose complete contents are taller than one " +
    "viewport — e.g. a five-question card where a screenshot shows only the " +
    'first two questions and its "Answered" footer. Set scope:"body" to ' +
    "catch toasts, which render in a portal outside <main>. Vision aiAssert " +
    'is for how things look; this node is for "all of these words exist ' +
    'somewhere on the page". Use "matches" for regex patterns (e.g. ' +
    "date-dependent headings that must stay independent of the run month).",
  inputSchema: expectTextsInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const root = input.scope === "body" ? page.locator("body") : page.locator("main").first();
    const patterns = input.matches.map((source) => new RegExp(source, "i"));
    // The transcript renders after the messages fetch resolves (and toasts
    // appear briefly after an action); poll for the text instead of requiring
    // it to be present on the first read.
    const deadline = Date.now() + 10_000;
    let text = "";
    for (;;) {
      text = (await root.innerText().catch(() => "")).toLowerCase();
      const missing = input.all.filter((needle) => !text.includes(needle.toLowerCase()));
      const present = input.none.filter((needle) => text.includes(needle.toLowerCase()));
      const unmatched = patterns.filter((pattern) => !pattern.test(text)).map(String);
      if (
        (missing.length === 0 && present.length === 0 && unmatched.length === 0) ||
        Date.now() >= deadline
      ) {
        if (!text) throw new Error(`app.expectTexts: no ${input.scope} text found`);
        if (missing.length > 0) {
          throw new Error(`app.expectTexts: missing expected text: ${JSON.stringify(missing)}`);
        }
        if (present.length > 0) {
          throw new Error(
            `app.expectTexts: text expected absent was found: ${JSON.stringify(present)}`,
          );
        }
        if (unmatched.length > 0) {
          throw new Error(`app.expectTexts: text did not match: ${JSON.stringify(unmatched)}`);
        }
        return;
      }
      await page.waitForTimeout(500);
    }
  },
});


const expectUrlInput = z.strictObject({
  // Substring matched against the full URL; prefix with "re:" for a regex.
  path: z.string().min(1),
});

const appExpectUrl = defineNode<typeof expectUrlInput, void, ProjectContext>({
  name: "app.expectUrl",
  description: "Assert the current URL matches the given substring or re: regex.",
  inputSchema: expectUrlInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const current = page.url();
    const matched = input.path.startsWith("re:")
      ? new RegExp(input.path.slice(3)).test(current)
      : current.includes(input.path);
    if (!matched) {
      throw new Error(`Expected URL to match "${input.path}" but got "${current}"`);
    }
  },
});

const expectResponseInput = z.strictObject({
  method: z.string().min(1),
  path: z.string().startsWith("/api/"),
  status: z.number().int().min(100).max(599),
  requestBodyIncludes: z.array(z.string().min(1)).default([]),
});

const appExpectResponse = defineNode<typeof expectResponseInput, void, ProjectContext>({
  name: "app.expectResponse",
  description:
    "Assert an API response observed since app.open, including the request method, path, status, " +
    "and optional request-body fragments. Use for transient outcomes that disappear before a " +
    "second model screenshot.",
  inputSchema: expectResponseInput,
  async execute({ context, input }) {
    if (!context.page || !context.apiResponses) {
      throw new Error("No page is open; call app.open first");
    }
    const matches = () =>
      context.apiResponses?.some(
        (response) =>
          response.method === input.method &&
          response.path === input.path &&
          response.status === input.status &&
          input.requestBodyIncludes.every((part) => response.requestBody.includes(part)),
      );
    const deadline = Date.now() + 10_000;
    while (!matches() && Date.now() < deadline) {
      await context.page.waitForTimeout(250);
    }
    if (!matches()) {
      throw new Error(
        `No ${input.method} ${input.path} response with status ${input.status} and requested body fragments`,
      );
    }
  },
});


const pressKeyInput = z.strictObject({
  // Combo like "mod+k", "mod+b", "mod+shift+o", or a single key
  // "Escape"/"Enter". "mod" maps to Meta on macOS and Control elsewhere, so
  // the same case works locally and on Linux CI (Rome binds both).
  key: z.string().min(1),
});

const appPressKey = defineNode<typeof pressKeyInput, void, ProjectContext>({
  name: "app.pressKey",
  description:
    'Press a keyboard shortcut deterministically. Use "mod" for the ' +
    "platform modifier (Cmd on macOS, Ctrl on Linux/Windows).",
  inputSchema: pressKeyInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const parts = input.key
      .toLowerCase()
      .split("+")
      .map((part) => part.trim())
      .map((part) =>
        part === "mod" ? (process.platform === "darwin" ? "Meta" : "Control") : part,
      );
    await page.keyboard.press(parts.map((p) => (p.length > 1 ? capitalize(p) : p)).join("+"));
    await page.waitForTimeout(300);
  },
});

const tagList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

export default defineTestProject<ProjectContext>({
  test: { maxConcurrency: 1, testTimeout: 8 * 60_000 },
  projects: [
    {
      name: process.env.MIDSCENE_PROJECT_NAME ?? "web",
      retry: process.env.MIDSCENE_RETRY ? Number(process.env.MIDSCENE_RETRY) : 2,
      setup,
      files: { include: ["cases/**/*.{yaml,yml}"] },
      tags: {
        include: tagList(process.env.MIDSCENE_INCLUDE_TAGS),
        exclude: tagList(process.env.MIDSCENE_EXCLUDE_TAGS),
      },
    },
  ],
  nodes: [
    ...createMidsceneNodes<ProjectContext>({ agentClass: PlaywrightAgent, getAgent }),
    appOpen,
    appExpectUrl,
    appExpectResponse,
    appClickByLabel,
    appExpectTexts,
    appScrollTextIntoView,
    appPressKey,
  ],
});
