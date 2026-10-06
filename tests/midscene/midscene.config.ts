import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineNode, z } from "@midscene/test";
import type { NodeExecutionContext } from "@midscene/test";
import { defineProjectSetup, defineTestProject } from "@midscene/test/config";
import { createMidsceneNodes } from "@midscene/test/midscene";
import { PlaywrightAgent } from "@midscene/web/playwright/agent";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { installBrowserNetworkGuard } from "./browser-network-guard.js";

loadEnv({ path: fileURLToPath(new URL(".env", import.meta.url)) });

const BASE_URL = process.env.ROME_E2E_BASE_URL ?? "http://localhost:3200";
// The mock app boots with an English UI when no language is cached, but Chinese
// CI runners would detect zh-CN from the OS. Pin English explicitly so every
// assertion in the YAML cases targets one language.
const LOCALE = "en";

interface ProjectContext {
  browser: Browser;
  browserContext?: BrowserContext;
  page?: Page;
  agent?: PlaywrightAgent;
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
    await installBrowserNetworkGuard(browserContext, BASE_URL);
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
  ],
});
