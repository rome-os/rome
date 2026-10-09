import type { CodeHighlighterPlugin, DiagramPlugin, MathPlugin, PluginConfig } from "streamdown";

// Mermaid, KaTeX and Shiki are most of the Markdown renderer's weight, and
// most messages use none of them. Each plugin is fetched the first time a
// message needs it, so a page of plain prose never downloads them.

type LazyPluginName = "code" | "math";

const loaders: {
  code: () => Promise<CodeHighlighterPlugin>;
  math: () => Promise<MathPlugin>;
} = {
  code: () => import("@streamdown/code").then((module) => module.code),
  math: () => import("@streamdown/math").then((module) => module.math),
};

let mermaidPlugin: Promise<DiagramPlugin> | null = null;

function loadMermaidPlugin(): Promise<DiagramPlugin> {
  mermaidPlugin ??= import("@streamdown/mermaid")
    .then((module) => module.mermaid)
    .catch((error: unknown) => {
      // The next diagram retries, so a dropped chunk request is not permanent.
      mermaidPlugin = null;
      throw error;
    });
  return mermaidPlugin;
}

// Streamdown reads the diagram plugin only when it renders a diagram, and
// awaits the render, so this stand-in can fetch the real plugin there instead
// of holding back the message until it arrives.
const lazyMermaid: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid(config) {
    let pending = config;
    return {
      initialize(next) {
        pending = next;
      },
      async render(id, source) {
        const plugin = await loadMermaidPlugin();
        return plugin.getMermaid(pending).render(id, source);
      },
    };
  },
};

// Code and math plugins change how Markdown parses and renders, so Streamdown
// needs the real ones up front. Until one arrives, its blocks render as plain
// text, and every mounted Markdown re-renders once it does.
let loaded: PluginConfig = { mermaid: lazyMermaid };
const requested = new Set<LazyPluginName>();
const listeners = new Set<() => void>();

export function getMarkdownPlugins(): PluginConfig {
  return loaded;
}

export function subscribeToMarkdownPlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function requestPlugin(name: LazyPluginName): void {
  if (requested.has(name)) return;
  requested.add(name);
  loaders[name]()
    .then((plugin) => {
      loaded = { ...loaded, [name]: plugin };
      for (const notify of listeners) notify();
    })
    .catch((error: unknown) => {
      // A later message retries, so a dropped chunk request is not permanent.
      requested.delete(name);
      console.error(`[Markdown] Failed to load the ${name} plugin:`, error);
    });
}

// Conservative on purpose: a false positive only fetches a plugin early. Math
// needs `$$`, since single dollars are not math here.
const CODE_FENCE = /```|~~~/;
const MATH_DELIMITER = /\$\$/;

/** Starts loading the plugins this Markdown source needs. */
export function requestMarkdownPlugins(markdown: string): void {
  if (CODE_FENCE.test(markdown)) requestPlugin("code");
  if (MATH_DELIMITER.test(markdown)) requestPlugin("math");
}
