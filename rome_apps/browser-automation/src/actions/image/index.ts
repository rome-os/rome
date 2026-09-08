import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  Action,
  ActionConfig,
  ActionResult,
  CurrentActionContext,
} from "@rome-os/app-runtime";
import { getCurrentActionContext } from "@rome-os/app-runtime";
import type { BrowserCapabilityDiscovery, CdpSession } from "@rome-os/app-runtime/browser";
import {
  buildBrowserScriptExpression,
  isPageReadyForAutomation,
  loadCachedScriptSource,
  openDiscoveredPageSession,
} from "@rome-os/app-runtime/browser";

const IMAGE_GENERATION_SCRIPT_URL = new URL(
  /* rspackIgnore: true */ "./scraping_scripts/image_action.js",
  import.meta.url,
);
const IMAGE_DOWNLOAD_SCRIPT_URL = new URL(
  /* rspackIgnore: true */ "./scraping_scripts/image_download.js",
  import.meta.url,
);
const DEFAULT_PAGE_URL = "https://chatgpt.com/";
const THREADS_PROJECTS_ROOT = "/home/user";
const PAGE_READY_TIMEOUT_MS = 20_000;
const PAGE_READY_POLL_MS = 500;
const POST_RELOAD_SETTLE_MS = 10_000;

export interface ChatGPTImageBrowserResult {
  prompt: string;
  imageUrl: string;
  mimeType: string;
  imageDataBase64: string;
  width?: number;
  height?: number;
}

export interface ChatGPTImageDeps {
  capabilityDiscovery: BrowserCapabilityDiscovery;
  runImageGeneration?: (
    capabilityDiscovery: BrowserCapabilityDiscovery,
    input: { prompt: string; pageUrl: string; timeoutMs: number },
  ) => Promise<{
    endpoint: { name: string; browserUrl: string };
    result: ChatGPTImageBrowserResult;
  }>;
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
  getCurrentActionContext?: () => CurrentActionContext | undefined;
}

interface ChatGPTImageGenerationResult {
  prompt: string;
  conversationUrl: string;
}

interface ChatGPTImageDownloadResult {
  imageUrl: string;
  mimeType: string;
  imageDataBase64: string;
  width?: number;
  height?: number;
}

interface PageReadyProbe {
  readyState?: string;
  href?: string;
}

export async function generateImageWithChatGPT(
  capabilityDiscovery: BrowserCapabilityDiscovery,
  input: { prompt: string; pageUrl: string; timeoutMs: number },
): Promise<{
  endpoint: { name: string; browserUrl: string };
  result: ChatGPTImageBrowserResult;
}> {
  const page = await openDiscoveredPageSession(capabilityDiscovery, input.pageUrl);

  try {
    const generationResult = await runBrowserScriptInSession<ChatGPTImageGenerationResult>(
      page.session,
      {
        scriptUrl: IMAGE_GENERATION_SCRIPT_URL,
        entrypointExpression: "generateChatGPTImage",
        args: [{ prompt: input.prompt, timeout: input.timeoutMs }],
        autorunFlag: "__ROME_CHATGPT_IMAGE_AUTORUN__",
        missingEntrypointMessage:
          "generateChatGPTImage is not defined after loading the browser script",
      },
    );

    await page.session.send("Page.reload", { ignoreCache: true });
    await waitForPageReadyAfterReload(page.session, generationResult.conversationUrl);
    await sleep(POST_RELOAD_SETTLE_MS);

    const downloadResult = await runBrowserScriptInSession<ChatGPTImageDownloadResult>(
      page.session,
      {
        scriptUrl: IMAGE_DOWNLOAD_SCRIPT_URL,
        entrypointExpression: "downloadGeneratedChatGPTImage",
        autorunFlag: "__ROME_CHATGPT_IMAGE_DOWNLOAD_AUTORUN__",
        missingEntrypointMessage:
          "downloadGeneratedChatGPTImage is not defined after loading the browser script",
      },
    );

    return {
      endpoint: page.endpoint,
      result: {
        prompt: generationResult.prompt,
        imageUrl: downloadResult.imageUrl,
        mimeType: downloadResult.mimeType,
        imageDataBase64: downloadResult.imageDataBase64,
        width: downloadResult.width,
        height: downloadResult.height,
      },
    };
  } finally {
    await page.close();
  }
}

export function createChatGPTImageAction(config: ActionConfig, deps: ChatGPTImageDeps): Action {
  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The image prompt to send to ChatGPT Images",
        },
        relative_path: {
          type: "string",
          description:
            "Preferred relative output path within the active thread directory, for example sunshine.png or images/sunshine.png.",
        },
        url: {
          type: "string",
          description: "Optional ChatGPT URL to navigate to (default: https://chatgpt.com/)",
        },
        timeout: {
          type: "number",
          description: "Max wait time in milliseconds for image generation (default: 900000)",
        },
      },
      required: ["prompt", "relative_path"],
    },
    execute: async (args: Record<string, unknown>): Promise<ActionResult> => {
      try {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) {
          return { status: "error", error: "prompt is required" };
        }

        const rawRelativePath =
          typeof args.relative_path === "string" ? args.relative_path.trim() : "";
        const legacyPath = typeof args.path === "string" ? args.path.trim() : "";
        if (legacyPath) {
          return { status: "error", error: "path is no longer supported; use relative_path" };
        }
        if (!rawRelativePath) {
          return { status: "error", error: "relative_path is required" };
        }

        const pageUrl =
          typeof args.url === "string" && args.url.trim().length > 0
            ? args.url.trim()
            : DEFAULT_PAGE_URL;
        const timeoutMs =
          typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0
            ? args.timeout
            : 900_000;

        const runImageGeneration = deps.runImageGeneration ?? generateImageWithChatGPT;

        const { endpoint, result } = await runImageGeneration(deps.capabilityDiscovery, {
          prompt,
          pageUrl,
          timeoutMs,
        });

        const currentActionContext = deps.getCurrentActionContext ?? getCurrentActionContext;
        const targetPath = resolveRelativeThreadPath(rawRelativePath, currentActionContext());
        const fileBuffer = Buffer.from(result.imageDataBase64, "base64");
        const ensureDir = deps.mkdir ?? mkdir;
        const persistFile = deps.writeFile ?? writeFile;

        await ensureDir(dirname(targetPath), { recursive: true });
        await persistFile(targetPath, fileBuffer);

        return {
          status: "ok",
          data: {
            path: targetPath,
            prompt: result.prompt,
            imageUrl: result.imageUrl,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
            browser: endpoint.name,
          },
        };
      } catch (error) {
        return {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export function createAction(config: ActionConfig, deps: ChatGPTImageDeps): Action {
  return createChatGPTImageAction(config, deps);
}

function resolveRelativeThreadPath(
  relativePath: string,
  actionContext?: CurrentActionContext,
): string {
  if (!relativePath) {
    throw new Error("relative_path is required");
  }

  if (isAbsolute(relativePath)) {
    throw new Error("relative_path must be relative");
  }

  const threadRoot = resolveThreadRoot(actionContext);
  const resolvedPath = resolve(threadRoot, relativePath);
  const pathWithinThread = relative(threadRoot, resolvedPath);

  if (
    pathWithinThread === ".." ||
    pathWithinThread.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinThread)
  ) {
    throw new Error("relative output path must stay within the current thread directory");
  }

  return resolvedPath;
}

function resolveThreadRoot(actionContext?: CurrentActionContext): string {
  const runtimeThreadPath = actionContext?.channelContext?.threadPath?.trim();
  if (runtimeThreadPath) {
    if (!isAbsolute(runtimeThreadPath)) {
      throw new Error("threadPath is invalid for relative output path resolution");
    }

    return runtimeThreadPath;
  }

  const projectName = normalizePathSegment(
    actionContext?.channelContext?.projectName,
    "projectName",
  );
  const threadId = normalizePathSegment(actionContext?.channelContext?.threadId, "threadId");
  return join(THREADS_PROJECTS_ROOT, projectName, ".threads", threadId);
}

function normalizePathSegment(value: string | undefined, fieldName: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error(`${fieldName} is required when using a relative output path`);
  }

  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`${fieldName} is invalid for relative output path resolution`);
  }

  if (/[\0-\x1f]/.test(trimmed)) {
    throw new Error(`${fieldName} contains unsupported characters`);
  }

  return trimmed;
}

async function runBrowserScriptInSession<TResult>(
  session: CdpSession,
  options: {
    scriptUrl: URL;
    entrypointExpression: string;
    args?: unknown[];
    autorunFlag?: string;
    missingEntrypointMessage?: string;
  },
): Promise<TResult> {
  const scriptSource = await loadCachedScriptSource(options.scriptUrl);
  const expression = buildBrowserScriptExpression({
    scriptSource,
    entrypointExpression: options.entrypointExpression,
    args: options.args,
    autorunFlag: options.autorunFlag,
    missingEntrypointMessage: options.missingEntrypointMessage,
  });

  return await session.evaluateByValue<TResult>(expression);
}

async function waitForPageReadyAfterReload(
  session: CdpSession,
  expectedUrl?: string,
): Promise<void> {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const probe = await session.evaluateByValue<PageReadyProbe>(
        "({ readyState: document.readyState, href: location.href })",
      );
      const href = probe.href?.trim();

      if (isPageReadyForAutomation(probe) && (!expectedUrl || !href || href === expectedUrl)) {
        return;
      }
    } catch {
      // The page may be mid-navigation; keep polling.
    }

    await sleep(PAGE_READY_POLL_MS);
  }

  throw new Error(
    `Timed out waiting for the page to finish reloading after ${PAGE_READY_TIMEOUT_MS}ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
