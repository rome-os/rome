// Shiki code highlighting for Streamdown, run in a Web Worker. Shiki's first
// highlight of a language compiles its whole grammar into regexes, which held
// the main thread for about a second per code block on a throttled CPU. The
// worker runs the stock @streamdown/code plugin, so tokens and themes match it.

import { code as mainThreadCode } from "@streamdown/code";
import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown";

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;

/** A request from the page to the highlighter worker. */
export interface HighlightRequest {
  id: number;
  options: HighlightOptions;
}

/** The worker's answer to a request. `result` is null when highlighting failed. */
export interface HighlightResponse {
  id: number;
  result: HighlightResult | null;
}

type Callback = (result: HighlightResult) => void;

interface Pending {
  key: string;
  options: HighlightOptions;
  callbacks: Set<Callback>;
  timer?: ReturnType<typeof setTimeout>;
}

// The stock plugin swallows an async failure, such as a grammar chunk that did
// not load, and never answers. It also keeps the failed highlighter, so asking
// the same worker again cannot succeed. A request with no answer by then retires
// the worker, and it and every later request go to the main thread.
const GIVE_UP_AFTER_MS = 20_000;
// A streamed block is highlighted once per partial version, each under its own
// key, so the page keeps only the most recent results.
const MAX_RESULTS = 200;

function themeName(theme: HighlightOptions["themes"][number]): string {
  return typeof theme === "string" ? theme : (theme.name ?? "custom");
}

function cacheKey({ code, language, themes }: HighlightOptions): string {
  return `${language}:${themeName(themes[0])}:${themeName(themes[1])}:${code}`;
}

/**
 * Creates a Streamdown code plugin that highlights in a worker made by
 * `createWorker`. `highlight` returns a cached result synchronously, or null
 * and calls `callback` once it has an answer. Requests go to `fallback` on the
 * main thread when no worker can be made. A worker that fails to load, answers
 * that it could not highlight a block, or leaves one unanswered for
 * GIVE_UP_AFTER_MS is retired, and its pending and later requests go to
 * `fallback` too.
 */
export function createWorkerCodePlugin(
  createWorker: () => Worker | null,
  fallback: CodeHighlighterPlugin = mainThreadCode,
): CodeHighlighterPlugin {
  const results = new Map<string, HighlightResult>();
  const pendingByKey = new Map<string, Pending>();
  const pendingById = new Map<number, Pending>();
  let worker: Worker | null | undefined;
  let nextId = 0;

  function remember(key: string, result: HighlightResult) {
    results.delete(key);
    results.set(key, result);
    if (results.size > MAX_RESULTS) {
      const oldest = results.keys().next().value;
      if (oldest !== undefined) results.delete(oldest);
    }
  }

  function useFallback(options: HighlightOptions, callback?: Callback) {
    return fallback.highlight(options, callback);
  }

  function failWorker() {
    if (!worker) return;
    worker.terminate();
    worker = null;
    console.warn("[Markdown] Code highlighting moved to the main thread: the worker failed.");
    const stranded = [...pendingById.values()];
    pendingById.clear();
    pendingByKey.clear();
    for (const pending of stranded) {
      clearTimeout(pending.timer);
      for (const callback of pending.callbacks) {
        const result = useFallback(pending.options, callback);
        if (result) callback(result);
      }
    }
  }

  function getWorker(): Worker | null {
    if (worker !== undefined) return worker;
    try {
      worker = createWorker();
    } catch {
      worker = null;
    }
    if (!worker) return null;
    worker.addEventListener("message", (event: MessageEvent<HighlightResponse>) => {
      const { id, result } = event.data;
      const pending = pendingById.get(id);
      if (!pending) return;
      if (!result) {
        failWorker();
        return;
      }
      clearTimeout(pending.timer);
      pendingById.delete(id);
      pendingByKey.delete(pending.key);
      remember(pending.key, result);
      for (const callback of pending.callbacks) callback(result);
    });
    worker.addEventListener("error", failWorker);
    worker.addEventListener("messageerror", failWorker);
    return worker;
  }

  return {
    name: "shiki",
    type: "code-highlighter",
    supportsLanguage: (language) => fallback.supportsLanguage(language),
    getSupportedLanguages: () => fallback.getSupportedLanguages(),
    getThemes: () => fallback.getThemes(),
    highlight(options, callback) {
      const key = cacheKey(options);
      const cached = results.get(key);
      if (cached) {
        remember(key, cached);
        return cached;
      }

      const target = getWorker();
      if (!target) return useFallback(options, callback);

      const pending = pendingByKey.get(key);
      if (pending) {
        if (callback) pending.callbacks.add(callback);
        return null;
      }
      const id = nextId++;
      const entry: Pending = { key, options, callbacks: new Set(callback ? [callback] : []) };
      pendingByKey.set(key, entry);
      pendingById.set(id, entry);
      target.postMessage({ id, options } satisfies HighlightRequest);
      entry.timer = setTimeout(failWorker, GIVE_UP_AFTER_MS);
      return null;
    },
  };
}

function createHighlighterWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("./code-highlighter.worker.js", import.meta.url), {
    type: "module",
    name: "shiki",
  });
}

/** Streamdown's Shiki plugin, highlighting off the main thread where workers exist. */
export const code = createWorkerCodePlugin(createHighlighterWorker);
