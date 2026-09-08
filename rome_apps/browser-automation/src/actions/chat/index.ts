import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Action, ActionConfig, ActionResult } from "@rome-os/app-runtime";
import type { BrowserCapabilityDiscovery, OpenedPageSession } from "@rome-os/app-runtime/browser";
import {
  buildBrowserScriptExpression,
  loadCachedScriptSource,
  openDiscoveredPageSession,
} from "@rome-os/app-runtime/browser";
import { acquireChatGPTClipboardLock } from "./clipboard_lock.js";

const CHAT_SCRIPT_URL = new URL(
  /* rspackIgnore: true */ "./scraping_scripts/chat_action.js",
  import.meta.url,
);
const CHECK_RESPONSE_COMPLETE_SCRIPT_URL = new URL(
  /* rspackIgnore: true */ "./scraping_scripts/check_response_complete.js",
  import.meta.url,
);
const COPY_RESPONSE_SCRIPT_URL = new URL(
  /* rspackIgnore: true */ "./scraping_scripts/copy_response.js",
  import.meta.url,
);
const execFile = promisify(execFileCallback);
const CLIPBOARD_POST_COPY_CONFIRMED_DELAY_MS = 100;
const CLIPBOARD_SETTLE_DELAY_MS = 350;

export interface ChatGPTChatDeps {
  capabilityDiscovery: BrowserCapabilityDiscovery;
  readClipboardText?: () => Promise<string>;
}

interface ChatGPTBrowserResponse {
  prompt: string;
  responseText: string;
  sources: Array<{ title: string; url: string }>;
  timestamp: string;
}

interface ChatGPTResponseCompleteBrowserResponse {
  complete: boolean;
}

interface ChatGPTCopyBrowserResponse {
  copyConfirmed: boolean;
}

interface ChatGPTFallbackResponse {
  response: string;
  sources: Array<{ title: string; url: string }>;
}

export async function readClipboardText(
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const commands =
    platform === "darwin"
      ? [{ command: "pbpaste", args: [] }]
      : platform === "win32"
        ? [
            {
              command: "powershell",
              args: ["-NoProfile", "-Command", "Get-Clipboard"],
            },
          ]
        : [
            { command: "wl-paste", args: ["--no-newline"] },
            { command: "xclip", args: ["-selection", "clipboard", "-o"] },
            { command: "xsel", args: ["--clipboard", "--output"] },
          ];

  let lastError: Error | undefined;
  for (const { command, args } of commands) {
    try {
      const { stdout } = await execFile(command, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      return stdout.replace(/\r\n/g, "\n");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `Failed to read clipboard text on ${platform}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

export function createChatGPTChatAction(config: ActionConfig, deps: ChatGPTChatDeps): Action {
  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The prompt/question to send to ChatGPT",
        },
        url: {
          type: "string",
          description:
            "Optional ChatGPT URL to navigate to (default: https://chatgpt.com/). Can be a specific GPT or project URL.",
        },
        timeout: {
          type: "number",
          description: "Max wait time in milliseconds for the response (default: 1800000)",
        },
      },
      required: ["prompt"],
    },
    execute: async (args: Record<string, unknown>): Promise<ActionResult> => {
      let page: OpenedPageSession | null = null;
      try {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) {
          return { status: "error", error: "prompt is required" };
        }

        const url = typeof args.url === "string" ? args.url.trim() : "https://chatgpt.com/";
        const timeout =
          typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : 1_800_000;
        const clipboardReader = deps.readClipboardText ?? readClipboardText;

        page = await openDiscoveredPageSession(deps.capabilityDiscovery, url);
        const result = await runBrowserScriptInOpenPage<ChatGPTBrowserResponse>(page, {
          scriptUrl: CHAT_SCRIPT_URL,
          entrypointExpression: "chatWithChatGPT",
          args: [{ prompt, timeout }],
          autorunFlag: "__ROME_CHATGPT_CHAT_AUTORUN__",
          missingEntrypointMessage: "chatWithChatGPT is not defined after loading the script",
        });

        let responseComplete = false;
        let copyConfirmed = false;
        let clipboardBefore: string | null = null;
        let clipboardAfter: string | null = null;

        const lock = await acquireChatGPTClipboardLock();
        try {
          await page.session.send("Page.bringToFront");
          responseComplete = await checkLatestChatGPTResponseComplete(page);

          if (responseComplete) {
            clipboardBefore = await safeReadClipboardText(clipboardReader);
            copyConfirmed = await copyLatestChatGPTResponseWithRetry(page);
            await sleep(CLIPBOARD_POST_COPY_CONFIRMED_DELAY_MS);
            clipboardAfter = await readClipboardAfterCopy(clipboardReader, clipboardBefore);

            if (clipboardAfter === clipboardBefore) {
              copyConfirmed = (await copyLatestChatGPTResponseWithRetry(page, 1)) || copyConfirmed;
              await sleep(CLIPBOARD_POST_COPY_CONFIRMED_DELAY_MS);
              clipboardAfter = await readClipboardAfterCopy(clipboardReader, clipboardBefore);
            }
          }
        } finally {
          await lock.release();
        }

        const clipboardChanged =
          clipboardAfter !== null &&
          clipboardAfter.trim().length > 0 &&
          clipboardAfter !== clipboardBefore;
        const markdownCopied = clipboardChanged;

        if (!responseComplete) {
          console.warn(
            "[chatgpt_chat] incomplete response fell back to scraped text",
            JSON.stringify({
              responseLength: result.responseText.length,
              sourcesCount: result.sources.length,
              responsePreview: result.responseText.slice(0, 280),
            }),
          );
        }

        if (responseComplete && !markdownCopied) {
          console.warn(
            "[chatgpt_chat] complete response fell back to scraped text",
            JSON.stringify({
              copyConfirmed,
              clipboardChanged,
              clipboardBeforeLength: clipboardBefore?.length ?? null,
              clipboardAfterLength: clipboardAfter?.length ?? null,
              responseLength: result.responseText.length,
              sourcesCount: result.sources.length,
              responsePreview: result.responseText.slice(0, 280),
            }),
          );
        }

        return {
          status: "ok",
          data:
            markdownCopied && clipboardAfter !== null
              ? postProcessCopiedReportMarkdown(clipboardAfter)
              : ({
                  response: result.responseText,
                  sources: result.sources,
                } satisfies ChatGPTFallbackResponse),
        };
      } catch (error) {
        return {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (page) {
          await page.close();
        }
      }
    },
  };
}

export function createAction(config: ActionConfig, deps: ChatGPTChatDeps): Action {
  return createChatGPTChatAction(config, deps);
}

async function runBrowserScriptInOpenPage<TResult>(
  page: OpenedPageSession,
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

  return await page.session.evaluateByValue<TResult>(expression);
}

async function copyLatestChatGPTResponseWithRetry(
  page: OpenedPageSession,
  maxAttempts: number = 2,
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const copyResult = await runBrowserScriptInOpenPage<ChatGPTCopyBrowserResponse>(page, {
        scriptUrl: COPY_RESPONSE_SCRIPT_URL,
        entrypointExpression: "copyLatestChatGPTResponse",
        autorunFlag: "__ROME_CHATGPT_COPY_RESPONSE_AUTORUN__",
        missingEntrypointMessage:
          "copyLatestChatGPTResponse is not defined after loading the script",
      });

      if (copyResult.copyConfirmed) {
        return true;
      }
    } catch {
      // Fall back to scraped text if both best-effort copy attempts fail.
    }
  }

  return false;
}

async function checkLatestChatGPTResponseComplete(
  page: OpenedPageSession,
  timeout: number = 5_000,
): Promise<boolean> {
  const result = await runBrowserScriptInOpenPage<ChatGPTResponseCompleteBrowserResponse>(page, {
    scriptUrl: CHECK_RESPONSE_COMPLETE_SCRIPT_URL,
    entrypointExpression: "waitForLatestChatGPTResponseComplete",
    args: [{ timeout }],
    autorunFlag: "__ROME_CHATGPT_CHECK_RESPONSE_COMPLETE_AUTORUN__",
    missingEntrypointMessage:
      "waitForLatestChatGPTResponseComplete is not defined after loading the script",
  });

  return result.complete;
}

async function safeReadClipboardText(readClipboard: () => Promise<string>): Promise<string | null> {
  try {
    return await readClipboard();
  } catch {
    return null;
  }
}

async function readClipboardAfterCopy(
  readClipboard: () => Promise<string>,
  clipboardBefore: string | null,
): Promise<string | null> {
  let clipboardAfter = await safeReadClipboardText(readClipboard);
  if (clipboardAfter !== clipboardBefore) {
    return clipboardAfter;
  }

  await sleep(CLIPBOARD_SETTLE_DELAY_MS);
  clipboardAfter = await safeReadClipboardText(readClipboard);
  return clipboardAfter;
}

export function postProcessCopiedReportMarkdown(markdown: string): string {
  const { body, references } = splitTrailingMarkdownReferences(markdown);
  if (countWords(body) <= 200) {
    return markdown;
  }

  const bodyWithoutTrailingWhitespace = body.replace(/\s+$/, "");
  const parts = bodyWithoutTrailingWhitespace.split(/(\n\s*\n+)/);
  let lastParagraphIndex = -1;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part || /^\n\s*\n+$/.test(part) || part.trim().length === 0) {
      continue;
    }
    lastParagraphIndex = index;
    break;
  }

  if (lastParagraphIndex === -1) {
    return markdown;
  }

  const lastParagraph = parts[lastParagraphIndex].trim();
  if (!shouldRemoveTrailingOfferParagraph(lastParagraph)) {
    return markdown;
  }

  const removalStartIndex = Math.max(0, lastParagraphIndex - 1);
  parts.splice(removalStartIndex, parts.length - removalStartIndex);
  const cleanedBody = parts.join("").replace(/\s+$/, "");
  return references.length > 0 ? `${cleanedBody}\n\n${references}` : cleanedBody;
}

function countWords(text: string): number {
  return text.trim().match(/\b[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*\b/gu)?.length ?? 0;
}

function shouldRemoveTrailingOfferParagraph(paragraph: string): boolean {
  return /^(?:If (?:you want|useful|[^,\n]+), I can\b|I can (?:also )?turn\b)/.test(paragraph);
}

function splitTrailingMarkdownReferences(markdown: string): {
  body: string;
  references: string;
} {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let endIndex = lines.length - 1;

  while (endIndex >= 0 && lines[endIndex].trim().length === 0) {
    endIndex -= 1;
  }

  let cursor = endIndex;
  let referenceStartIndex = -1;
  while (cursor >= 0 && /^\[[^\]]+\]:\s+\S/.test(lines[cursor])) {
    referenceStartIndex = cursor;
    cursor -= 1;
  }

  if (referenceStartIndex === -1) {
    return { body: markdown.replace(/\r\n/g, "\n"), references: "" };
  }

  const body = lines.slice(0, referenceStartIndex).join("\n");
  const references = lines.slice(referenceStartIndex, endIndex + 1).join("\n");
  return { body, references };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
