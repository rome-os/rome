/**
 * The page the ChatGPT actions drive, opened on whichever browser connection
 * the instance has.
 *
 * OpenCLI's Browser Bridge is the browser connection Rome ships with (see
 * DEVELOPMENT.md). CDP discovery runs only when ROME_ENABLE_CDP_AUTOMATION=true,
 * so a discovered endpoint is used when one exists and the Browser Bridge
 * otherwise.
 *
 * Each OpenCLI call is a separate `opencli browser <session> ...` process, and
 * the daemon caps one call at two minutes. A ChatGPT script runs for up to
 * thirty, so an OpenCLI script call runs as a job in the page: one call
 * starts it, and later calls wait on it in slices shorter than the cap.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BrowserCapabilityDiscovery, OpenedPageSession } from "@rome-os/app-runtime/browser";
import {
  buildBrowserScriptExpression,
  isPageReadyForAutomation,
  loadCachedScriptSource,
  openDiscoveredPageSession,
  pickBrowserEndpoint,
} from "@rome-os/app-runtime/browser";

export interface BrowserScriptCall {
  scriptUrl: URL;
  entrypointExpression: string;
  args?: unknown[];
  autorunFlag?: string;
  /** How long the script itself may run, in milliseconds. */
  timeoutMs: number;
}

export interface AutomationPage {
  /** The browser the page runs in: a CDP endpoint name, `opencli`, or `opencli:<profile>`. */
  readonly browser: string;
  /** Resolves with the entrypoint's return value. Rejects with the script's error message when it throws. */
  runScript<T>(call: BrowserScriptCall): Promise<T>;
  /** Best effort. A page that cannot be raised still runs scripts. */
  bringToFront(): Promise<void>;
  /** Resolves once the reloaded page is ready at expectedUrl, when given. */
  reload(expectedUrl?: string): Promise<void>;
  /** Closes the page. Never rejects. */
  close(): Promise<void>;
}

/** One opencli invocation. `code` is null when the process was killed before it exited. */
export interface OpencliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunOpencli = (args: string[], options: { timeoutMs: number }) => Promise<OpencliResult>;

export interface OpenAutomationPageOptions {
  /** An OpenCLI profile name or id from `opencli profile list`. Selects the Browser Bridge even when CDP discovery is on. */
  profile?: string;
  /** Prefixes the OpenCLI session name, so the browser's tab lease shows which action holds it. */
  sessionPrefix: string;
  runOpencli?: RunOpencli;
}

const PAGE_READY_TIMEOUT_MS = 30_000;
const PAGE_READY_POLL_MS = 500;
const PAGE_READY_STABLE_POLLS = 2;
const OPENCLI_COMMAND_TIMEOUT_MS = 150_000;
const OPENCLI_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// Below the daemon's two-minute cap per call, with room for a throttled
// background tab to fire the timer late.
const JOB_WAIT_SLICE_MS = 20_000;
// Covers the work a script does after its own deadline, such as collecting a
// partial response.
const JOB_DEADLINE_MARGIN_MS = 60_000;
const JOB_POLL_FAILURE_LIMIT = 3;
// Script arguments travel as eval text. Linux refuses a single argv entry over
// 128 KiB, and a prompt can be longer than that.
const INPUT_CHUNK_CHARS = 32_000;
const JOBS_GLOBAL = "__romeBrowserJobs";
const INPUTS_GLOBAL = "__romeBrowserJobInputs";
const RELOAD_MARKER_GLOBAL = "__romeBrowserReloadMarker";

interface PageReadyProbe {
  readyState?: string;
  href?: string;
  reloadPending?: boolean;
}

type JobState =
  | { state: "running" }
  | { state: "done"; value?: unknown }
  | { state: "error"; message?: string }
  | { state: "missing" };

/**
 * Opens url in a new page. Uses a discovered CDP endpoint unless profile is
 * set or discovery found none, then OpenCLI's Browser Bridge. Rejects with an
 * error naming the unmet prerequisite when no browser can open the page.
 */
export async function openAutomationPage(
  capabilityDiscovery: BrowserCapabilityDiscovery,
  url: string,
  options: OpenAutomationPageOptions,
): Promise<AutomationPage> {
  const profile = normalizeProfile(options.profile);
  if (!profile && pickBrowserEndpoint(capabilityDiscovery.getBrowserEndpoints())) {
    return cdpAutomationPage(await openDiscoveredPageSession(capabilityDiscovery, url));
  }

  const page = new OpencliAutomationPage(
    options.runOpencli ?? runOpencli,
    `${options.sessionPrefix}-${randomUUID()}`,
    profile,
  );
  await page.open(url);
  return page;
}

/** Runs `opencli <args>`, honoring ROME_OPENCLI_BIN. Rejects only when the binary cannot start. */
export function runOpencli(args: string[], options: { timeoutMs: number }): Promise<OpencliResult> {
  const bin = process.env.ROME_OPENCLI_BIN ?? "opencli";
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: options.timeoutMs, maxBuffer: OPENCLI_MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
        if (failure?.syscall?.startsWith("spawn")) {
          reject(
            new Error(
              `ChatGPT browser automation needs OpenCLI, and \`${bin}\` could not be run: ${failure.message}. ` +
                "Install @yunfanye/opencli, or set ROME_ENABLE_CDP_AUTOMATION=true to use CDP browser discovery.",
            ),
          );
          return;
        }
        if (!failure) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        // A kill on timeout or on output overflow leaves no exit code, so the
        // error message is the only account of what happened.
        const code = typeof failure.code === "number" ? failure.code : null;
        resolve({ code, stdout, stderr: code === null ? `${stderr}\n${failure.message}` : stderr });
      },
    );
  });
}

function normalizeProfile(profile: string | undefined): string | undefined {
  const trimmed = profile?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`profile must be a name or id from \`opencli profile list\`, got "${trimmed}"`);
  }
  return trimmed;
}

function cdpAutomationPage(page: OpenedPageSession): AutomationPage {
  const probe = () =>
    page.session.evaluateByValue<PageReadyProbe>(
      "({ readyState: document.readyState, href: location.href })",
    );

  return {
    browser: page.endpoint.name,
    runScript: async <T>(call: BrowserScriptCall): Promise<T> => {
      const scriptSource = await loadCachedScriptSource(call.scriptUrl);
      const expression = buildBrowserScriptExpression({
        scriptSource,
        entrypointExpression: call.entrypointExpression,
        args: call.args,
        autorunFlag: call.autorunFlag,
      });
      return await page.session.evaluateByValue<T>(expression);
    },
    bringToFront: async () => {
      await page.session.send("Page.bringToFront");
    },
    reload: async (expectedUrl) => {
      await page.session.send("Page.reload", { ignoreCache: true });
      await waitForPageReady(probe, { expectedUrl, stablePolls: 1 });
    },
    close: async () => {
      try {
        await page.close();
      } catch {
        // The page may already be gone.
      }
    },
  };
}

class OpencliAutomationPage implements AutomationPage {
  readonly browser: string;

  constructor(
    private readonly run: RunOpencli,
    private readonly session: string,
    private readonly profile: string | undefined,
  ) {
    this.browser = profile ? `opencli:${profile}` : "opencli";
  }

  async open(url: string): Promise<void> {
    const result = await this.invoke(["open", url]);
    if (result.code !== 0) {
      // A failed open holds no tab lease to release, and a close would wait
      // out the same browser connect timeout a second time.
      throw new Error(
        `ChatGPT browser automation drives a browser through OpenCLI's Browser Bridge, and OpenCLI could not open ${url}: ${failureDetail(result)}. ` +
          "Run `opencli profile list` to see the connected browsers and pass one as `profile`. " +
          "Settings > Advanced > Computer Use shows each browser connection.",
      );
    }

    try {
      await waitForPageReady(() => this.evalJson<PageReadyProbe>(probeExpression()), {
        stablePolls: PAGE_READY_STABLE_POLLS,
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async runScript<T>(call: BrowserScriptCall): Promise<T> {
    const jobId = randomUUID();
    const chunkCount = await this.stageInput(jobId, call.args ?? []);
    const scriptSource = await loadCachedScriptSource(call.scriptUrl);
    const expression = buildBrowserScriptExpression({
      scriptSource,
      // Wraps the entrypoint so it reads its arguments from the staged input.
      // A missing entrypoint stays non-callable, so the builder still reports it.
      entrypointExpression: `((entry) => typeof entry === "function" ? () => entry(...__romeScriptArgs) : entry)(${call.entrypointExpression})`,
      args: [],
      autorunFlag: call.autorunFlag,
    });

    const started = await this.evalJson<{ started: boolean; inputLost?: boolean }>(
      startJobExpression(jobId, chunkCount, expression),
    );
    if (started.inputLost) {
      throw new Error("The page reloaded before the browser script started, so its input was lost");
    }

    const deadline = Date.now() + call.timeoutMs + JOB_DEADLINE_MARGIN_MS;
    let failures = 0;
    while (Date.now() < deadline) {
      let job: JobState;
      try {
        job = await this.evalJson<JobState>(waitJobExpression(jobId, JOB_WAIT_SLICE_MS));
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= JOB_POLL_FAILURE_LIMIT) {
          throw error;
        }
        await sleep(PAGE_READY_POLL_MS);
        continue;
      }

      if (job.state === "done") {
        return job.value as T;
      }
      if (job.state === "error") {
        throw new Error(job.message || "The browser script failed");
      }
      if (job.state === "missing") {
        throw new Error(
          "The page navigated away or reloaded while the browser script ran, so its result was lost",
        );
      }
      if (job.state !== "running") {
        throw new Error(
          `OpenCLI returned an unexpected browser script state: ${JSON.stringify(job).slice(0, 200)}`,
        );
      }
    }

    throw new Error(
      `Timed out after ${call.timeoutMs + JOB_DEADLINE_MARGIN_MS}ms waiting for the browser script to finish`,
    );
  }

  async bringToFront(): Promise<void> {
    // OpenCLI opens the session in a foreground window already, and selecting
    // the tab would persist target state for this single-use session.
  }

  async reload(expectedUrl?: string): Promise<void> {
    const marker = randomUUID();
    await this.evalJson(reloadExpression(marker));
    await waitForPageReady(() => this.evalJson<PageReadyProbe>(probeExpression(marker)), {
      expectedUrl,
      stablePolls: 1,
    });
  }

  async close(): Promise<void> {
    try {
      await this.invoke(["close"]);
    } catch {
      // The daemon reclaims an idle tab lease on its own.
    }
  }

  private async stageInput(jobId: string, args: unknown[]): Promise<number> {
    const json = JSON.stringify(args);
    const chunkCount = Math.max(1, Math.ceil(json.length / INPUT_CHUNK_CHARS));
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = json.slice(index * INPUT_CHUNK_CHARS, (index + 1) * INPUT_CHUNK_CHARS);
      await this.evalJson(stageInputExpression(jobId, index, chunk));
    }
    return chunkCount;
  }

  private invoke(subcommand: string[]): Promise<OpencliResult> {
    const args = [
      ...(this.profile ? ["--profile", this.profile] : []),
      "browser",
      this.session,
      ...subcommand,
    ];
    return this.run(args, { timeoutMs: OPENCLI_COMMAND_TIMEOUT_MS });
  }

  private async evalJson<T>(expression: string): Promise<T> {
    const result = await this.invoke(["eval", expression]);
    if (result.code !== 0) {
      throw new Error(`OpenCLI could not run a script in the page: ${failureDetail(result)}`);
    }
    return parseEvalOutput<T>(result.stdout);
  }
}

async function waitForPageReady(
  probe: () => Promise<PageReadyProbe>,
  options: { expectedUrl?: string; stablePolls: number },
): Promise<void> {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  let stableReadyPolls = 0;
  let lastReadyHref: string | null = null;

  while (Date.now() < deadline) {
    try {
      const state = await probe();
      const href = state.href?.trim() ?? "";
      const atExpectedUrl = !options.expectedUrl || !href || href === options.expectedUrl;
      if (isPageReadyForAutomation(state) && !state.reloadPending && atExpectedUrl) {
        stableReadyPolls = href === lastReadyHref ? stableReadyPolls + 1 : 1;
        lastReadyHref = href;
        if (stableReadyPolls >= options.stablePolls) {
          return;
        }
      } else {
        stableReadyPolls = 0;
        lastReadyHref = null;
      }
    } catch {
      // The page may be mid-navigation; keep polling.
      stableReadyPolls = 0;
      lastReadyHref = null;
    }

    await sleep(PAGE_READY_POLL_MS);
  }

  throw new Error(
    `Timed out waiting for the page to finish loading after ${PAGE_READY_TIMEOUT_MS}ms`,
  );
}

function probeExpression(reloadMarker?: string): string {
  const reloadPending = reloadMarker
    ? `globalThis.${RELOAD_MARKER_GLOBAL} === ${JSON.stringify(reloadMarker)}`
    : "false";
  return `JSON.stringify({ readyState: document.readyState, href: location.href, reloadPending: ${reloadPending} })`;
}

// The marker lives on the old document only, so a probe that still sees it
// has not reached the reloaded page yet.
function reloadExpression(marker: string): string {
  return `(() => {
  globalThis.${RELOAD_MARKER_GLOBAL} = ${JSON.stringify(marker)};
  setTimeout(() => location.reload(), 0);
  return JSON.stringify(true);
})()`;
}

// Chunks are stored by index, so an eval OpenCLI retries after a navigation
// error writes the same slot again. A navigation partway through staging
// leaves holes in the new document's array, and the start check reads them
// through Array.from because Array.prototype.some skips holes.
function stageInputExpression(jobId: string, index: number, chunk: string): string {
  return `(() => {
  const inputs = (globalThis.${INPUTS_GLOBAL} ??= {});
  (inputs[${JSON.stringify(jobId)}] ??= [])[${index}] = ${JSON.stringify(chunk)};
  return JSON.stringify(true);
})()`;
}

// Idempotent: a repeated start finds the job registered and leaves it running.
function startJobExpression(jobId: string, chunkCount: number, scriptExpression: string): string {
  const id = JSON.stringify(jobId);
  return `(() => {
  const jobs = (globalThis.${JOBS_GLOBAL} ??= {});
  if (jobs[${id}]) return JSON.stringify({ started: false });
  const inputs = globalThis.${INPUTS_GLOBAL} ?? {};
  const chunks = inputs[${id}];
  delete inputs[${id}];
  if (!Array.isArray(chunks) || chunks.length !== ${chunkCount} || Array.from(chunks).some((chunk) => typeof chunk !== "string")) {
    return JSON.stringify({ started: false, inputLost: true });
  }
  const __romeScriptArgs = JSON.parse(chunks.join(""));
  const job = { state: "running" };
  jobs[${id}] = job;
  job.settled = Promise.resolve()
    .then(() => ${scriptExpression})
    .then(
      (value) => {
        job.state = "done";
        job.value = value;
      },
      (error) => {
        job.state = "error";
        job.message = error instanceof Error ? error.message : String(error);
      },
    );
  return JSON.stringify({ started: true });
})()`;
}

// Keeps a settled job after reporting it, so a poll whose output never
// reached Rome can be repeated. The page is disposable, and closing it
// discards the jobs.
function waitJobExpression(jobId: string, waitMs: number): string {
  const id = JSON.stringify(jobId);
  return `(async () => {
  const jobs = globalThis.${JOBS_GLOBAL};
  const job = jobs && jobs[${id}];
  if (!job) return JSON.stringify({ state: "missing" });
  if (job.state === "running") {
    await Promise.race([job.settled, new Promise((resolve) => setTimeout(resolve, ${waitMs}))]);
  }
  if (job.state === "running") return JSON.stringify({ state: "running" });
  return JSON.stringify(
    job.state === "done" ? { state: "done", value: job.value } : { state: "error", message: job.message },
  );
})()`;
}

/**
 * `opencli browser eval` prints a string result as is, and every expression
 * here returns single-line JSON text. The result is read from the last line
 * that parses, so a notice OpenCLI prints around it cannot hide it.
 */
function parseEvalOutput<T>(stdout: string): T {
  const lines = stdout.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]) as T;
    } catch {
      // Not the result line.
    }
  }
  throw new Error(`OpenCLI returned unreadable script output: ${stdout.trim().slice(0, 200)}`);
}

function failureDetail(result: OpencliResult): string {
  // OpenCLI colors its errors, marks each line with a "✖" glyph, and ends its
  // hint with a period. The message this detail lands in supplies its own.
  const text = `${result.stderr}\n${result.stdout}`.replace(/\u001b\[[0-9;]*m/g, "");
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^[\s\u2716]+/, "").trim())
    .filter(Boolean);
  const detail = lines.slice(0, 6).join(" ").slice(0, 600).replace(/\.+$/, "");
  if (detail) {
    return detail;
  }
  return result.code === null ? "the command timed out" : `exit code ${result.code}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
