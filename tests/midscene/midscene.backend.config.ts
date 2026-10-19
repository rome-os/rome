import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineNode, z } from "@midscene/test";
import type { NodeExecutionContext } from "@midscene/test";
import { defineProjectSetup, defineTestProject } from "@midscene/test/config";
import { createMidsceneNodes } from "@midscene/test/midscene";
import { PlaywrightAgent } from "@midscene/web/playwright/agent";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// Backend suite: the same Midscene cases format, run against a real Rome
// container started from the production image. Cases share one instance and
// run in path order, because the first case creates the account the later
// cases sign in with. Each case file is named for what it tests, with a
// numeric prefix that fixes that order: 01-onboarding.yaml, 02-....

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: process.env.ROME_E2E_ENV_FILE ?? resolve(here, ".env") });

const BASE_URL = process.env.ROME_E2E_BASE_URL ?? "http://127.0.0.1:8090";
const EVENTS_FILE = resolve(
  process.env.ROME_E2E_EVENTS_FILE ?? resolve(here, "midscene_run/backend-events.jsonl"),
);

// Synthetic credentials for the throwaway instance. The instance starts with
// empty volumes on every run, so a fixed value is safe.
const GUARDIAN = { userId: "e2e-guardian", password: "e2e-password-123" };
// A per-run marker the file case writes and the agent reads back. It is only
// known after the run starts, so the assertion cannot pass on a cached reply.
const FILE_TOKEN = process.env.ROME_E2E_FILE_TOKEN ?? `e2e-${Date.now().toString(36)}`;

interface BackendContext {
  browser: Browser;
  browserContext?: BrowserContext;
  page?: Page;
  agent?: PlaywrightAgent;
}

const recordEvent = (event: Record<string, unknown>) => {
  appendFileSync(EVENTS_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
};

const getAgent = ({ context }: NodeExecutionContext<unknown, BackendContext>) => {
  if (!context.page) throw new Error("No page is open; call app.open before AI steps");
  context.agent ??= new PlaywrightAgent(context.page, {
    aiContexts: {
      aiAct:
        "Coordinates are absolute from the full screenshot's top-left corner and stay inside " +
        "its bounds. Chat replies stream in: wait for the reply to finish before acting on it.",
    },
  });
  return context.agent;
};

const setup = defineProjectSetup<BackendContext>({
  name: "backend",
  async setup({ env, onTeardown }) {
    mkdirSync(dirname(EVENTS_FILE), { recursive: true });
    const browser = await chromium.launch({ headless: env.HEADLESS !== "false" });
    const context: BackendContext = { browser };
    onTeardown(async () => {
      await context.agent?.destroy();
      await context.browserContext?.close().catch(() => undefined);
      await browser.close();
    });
    return context;
  },
});

const openInput = z.strictObject({
  path: z.string().min(1),
  // 'guardian' signs in with the account ONBOARD-01 created before the page loads.
  session: z.enum(["none", "guardian"]).default("guardian"),
  // 'onboard' waits for the account form, 'shell' for the signed-in sidebar.
  waitUntil: z.enum(["onboard", "shell", "any"]).default("shell"),
});

const appOpen = defineNode<typeof openInput, void, BackendContext>({
  name: "app.open",
  description:
    "Open a Rome route in a fresh browser context against the real backend, optionally " +
    "signed in as the e2e guardian. Browser errors and failed responses are recorded.",
  inputSchema: openInput,
  async execute({ context, input }) {
    await context.agent?.destroy().catch(() => undefined);
    context.agent = undefined;
    await context.browserContext?.close().catch(() => undefined);

    const browserContext = await context.browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "Asia/Shanghai",
    });
    // No network guard, unlike the mock suite: the page makes the same
    // requests a guardian's browser makes, CDN assets included.
    await browserContext.addInitScript(() => {
      if (!window.localStorage.getItem("rome.lang")) window.localStorage.setItem("rome.lang", "en");
    });

    if (input.session === "guardian") {
      // The context's request client shares its cookie jar with the pages.
      const res = await browserContext.request.post(`${BASE_URL}/api/auth/login`, {
        data: GUARDIAN,
      });
      if (!res.ok()) throw new Error(`Guardian sign-in failed with HTTP ${res.status()}`);
    }

    const page = await browserContext.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") recordEvent({ source: "console", text: message.text() });
    });
    page.on("pageerror", (error) => recordEvent({ source: "pageerror", text: error.message }));
    // A failed request names its URL; the console line for it does not.
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      recordEvent({
        source: "requestfailed",
        origin: url.origin,
        path: url.pathname,
        error: request.failure()?.errorText ?? "",
      });
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      recordEvent({
        source: "http",
        status: response.status(),
        method: response.request().method(),
        path: url.pathname,
      });
    });
    context.browserContext = browserContext;
    context.page = page;

    await page.goto(`${BASE_URL}${input.path.startsWith("/") ? "" : "/"}${input.path}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    if (input.waitUntil === "onboard") {
      await page.locator('input[autocomplete="username"]').waitFor({ timeout: 60_000 });
    } else if (input.waitUntil === "shell") {
      await page.locator('a[href="/chat"]').first().waitFor({ timeout: 60_000 });
    }
  },
});

// The model configuration reaches Rome through the same API the Settings
// "Custom environment" form uses. No step types it, so the token never shows
// in a screenshot, a report, or a prompt sent to Midscene's model.
const readModelEnv = (): Record<string, string> => {
  const raw =
    process.env.ROME_E2E_ANTHROPIC_ENV_JSON ??
    (process.env.ROME_E2E_ANTHROPIC_ENV_FILE
      ? readFileSync(process.env.ROME_E2E_ANTHROPIC_ENV_FILE, "utf8")
      : undefined);
  if (!raw) {
    throw new Error("Set ROME_E2E_ANTHROPIC_ENV_JSON or ROME_E2E_ANTHROPIC_ENV_FILE");
  }
  const parsed = JSON.parse(raw) as { env?: Record<string, string> } & Record<string, string>;
  const env = parsed.env ?? parsed;
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    throw new Error("The model environment has no ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
  }
  return env;
};

const emptyInput = z.strictObject({});

const connectModel = defineNode<typeof emptyInput, void, BackendContext>({
  name: "backend.connectModel",
  description:
    "Store the maintainer's custom Anthropic environment as the signed-in guardian, then " +
    "confirm the AI status probe reports Claude as connected.",
  inputSchema: emptyInput,
  async execute({ context }) {
    const request = context.browserContext?.request;
    if (!request) throw new Error("No browser context; call app.open first");
    const save = await request.put(`${BASE_URL}/api/ai-tools/anthropic-compatible-credentials`, {
      data: { provider: "custom", env: readModelEnv() },
    });
    // Report the status only: an error body may echo the submitted values.
    if (!save.ok())
      throw new Error(`Saving the model environment failed with HTTP ${save.status()}`);
    const status = (await (await request.get(`${BASE_URL}/api/ai-tools/status`)).json()) as {
      claude?: { loggedIn?: boolean };
    };
    if (status.claude?.loggedIn !== true) {
      throw new Error("The AI status probe does not report Claude as connected");
    }
  },
});

const fileInput = z.strictObject({ path: z.string().min(1), contains: z.string().min(1) });

const expectProjectFile = defineNode<typeof fileInput, void, BackendContext>({
  name: "backend.expectProjectFile",
  description: "Read a project file through the backend and check that it contains a string.",
  inputSchema: fileInput,
  async execute({ context, input }) {
    const request = context.browserContext?.request;
    if (!request) throw new Error("No browser context; call app.open first");
    const res = await request.get(
      `${BASE_URL}/api/projects/file?path=${encodeURIComponent(input.path)}`,
    );
    if (!res.ok()) throw new Error(`Reading ${input.path} failed with HTTP ${res.status()}`);
    const body = (await res.json()) as { content?: string | null };
    if (!body.content?.includes(input.contains)) {
      throw new Error(`${input.path} does not contain "${input.contains}"`);
    }
  },
});

export default defineTestProject<BackendContext>({
  // Ordered, single-instance run: no concurrency, and a failed case stops the
  // rest because each case builds on the state the previous one left.
  test: { maxConcurrency: 1, testTimeout: 15 * 60_000, bail: 1 },
  projects: [
    {
      name: "web-backend",
      retry: process.env.MIDSCENE_RETRY ? Number(process.env.MIDSCENE_RETRY) : 0,
      setup,
      files: { include: ["backend/cases/**/*.{yaml,yml}"] },
      variables: {
        guardianUser: GUARDIAN.userId,
        guardianPassword: GUARDIAN.password,
        fileToken: FILE_TOKEN,
      },
    },
  ],
  nodes: [
    ...createMidsceneNodes<BackendContext>({ agentClass: PlaywrightAgent, getAgent }),
    appOpen,
    connectModel,
    expectProjectFile,
  ],
});
