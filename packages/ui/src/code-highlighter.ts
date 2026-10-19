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

/** The worker's answer to a request. */
export interface HighlightResponse {
  id: number;
  result: HighlightResult;
}

type Callback = (result: HighlightResult) => void;

interface Pending {
  key: string;
  options: HighlightOptions;
  callbacks: Set<Callback>;
}

function themeName(theme: HighlightOptions["themes"][number]): string {
  return typeof theme === "string" ? theme : (theme.name ?? "custom");
}

function cacheKey({ code, language, themes }: HighlightOptions): string {
  return `${language}:${themeName(themes[0])}:${themeName(themes[1])}:${code}`;
}

/**
 * Creates a Streamdown code plugin that highlights in a worker made by
 * `createWorker`. `highlight` returns a cached result synchronously, or null
 * and calls `callback` once the worker answers. When no worker can be made, or
 * the worker fails, requests go to `fallback` on the main thread instead.
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

  function failWorker() {
    worker?.terminate();
    worker = null;
    const stranded = [...pendingById.values()];
    pendingById.clear();
    pendingByKey.clear();
    for (const { options, callbacks } of stranded) {
      for (const callback of callbacks) {
        const result = fallback.highlight(options, callback);
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
      pendingById.delete(id);
      pendingByKey.delete(pending.key);
      results.set(pending.key, result);
      for (const callback of pending.callbacks) callback(result);
    });
    worker.addEventListener("error", failWorker);
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
      if (cached) return cached;

      const target = getWorker();
      if (!target) return fallback.highlight(options, callback);

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
