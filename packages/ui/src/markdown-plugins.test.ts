import { beforeEach, describe, expect, it, rs } from "@rstest/core";

// Each plugin module's export is read through a getter, so a test can make the
// next read throw, the way a dropped chunk request rejects the import.
const fakes = rs.hoisted(() => {
  const failures = { code: 0, math: 0, mermaid: 0 };
  const read = <T>(name: keyof typeof failures, value: T): T => {
    if (failures[name] > 0) {
      failures[name] -= 1;
      throw new Error(`${name} chunk failed`);
    }
    return value;
  };
  const code = { name: "shiki", type: "code-highlighter" };
  const math = { name: "katex", type: "math" };
  const configs: unknown[] = [];
  const render = rs.fn(async () => ({ svg: "<svg></svg>" }));
  const mermaid = {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid(config?: unknown) {
      configs.push(config);
      return { initialize() {}, render };
    },
  };
  return { failures, read, code, math, mermaid, configs, render };
});

rs.mock("@streamdown/code", () => ({
  get code() {
    return fakes.read("code", fakes.code);
  },
}));
rs.mock("@streamdown/math", () => ({
  get math() {
    return fakes.read("math", fakes.math);
  },
}));
rs.mock("@streamdown/mermaid", () => ({
  get mermaid() {
    return fakes.read("mermaid", fakes.mermaid);
  },
}));

type PluginsModule = typeof import("./markdown-plugins.js");

// The store is module state, so each test loads a fresh copy of it.
async function loadStore(): Promise<PluginsModule> {
  rs.resetModules();
  return import("./markdown-plugins.js");
}

function nextChange(store: PluginsModule): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = store.subscribeToMarkdownPlugins(() => {
      unsubscribe();
      resolve();
    });
  });
}

beforeEach(() => {
  fakes.failures.code = 0;
  fakes.failures.math = 0;
  fakes.failures.mermaid = 0;
  fakes.configs.length = 0;
  fakes.render.mockClear();
  rs.spyOn(console, "error").mockImplementation(() => {});
});

describe("markdown plugins", () => {
  it("starts with only the mermaid stand-in", async () => {
    const store = await loadStore();
    store.requestMarkdownPlugins("Plain prose that costs $5.");
    await Promise.resolve();

    const plugins = store.getMarkdownPlugins();
    expect(Object.keys(plugins)).toEqual(["mermaid"]);
    expect(plugins.mermaid).not.toBe(fakes.mermaid);
  });

  it("loads the code plugin for a fence and the math plugin for $$", async () => {
    const store = await loadStore();

    let changed = nextChange(store);
    store.requestMarkdownPlugins("```ts\nconst a = 1;\n```");
    await changed;
    expect(store.getMarkdownPlugins().code).toBe(fakes.code);
    expect(store.getMarkdownPlugins().math).toBeUndefined();

    changed = nextChange(store);
    store.requestMarkdownPlugins("Euler: $$e^{i\\pi} + 1 = 0$$");
    await changed;
    expect(store.getMarkdownPlugins().math).toBe(fakes.math);
  });

  it("keeps one snapshot until a plugin arrives, and notifies once per plugin", async () => {
    const store = await loadStore();
    const listener = rs.fn();
    store.subscribeToMarkdownPlugins(listener);
    const before = store.getMarkdownPlugins();

    const changed = nextChange(store);
    store.requestMarkdownPlugins("~~~\nplain\n~~~");
    store.requestMarkdownPlugins("```js\nagain\n```");
    expect(store.getMarkdownPlugins()).toBe(before);
    await changed;

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getMarkdownPlugins()).not.toBe(before);
  });

  it("retries a plugin whose chunk failed to load", async () => {
    const store = await loadStore();
    fakes.failures.math = 1;

    store.requestMarkdownPlugins("$$x$$");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getMarkdownPlugins().math).toBeUndefined();

    const changed = nextChange(store);
    store.requestMarkdownPlugins("$$x$$");
    await changed;
    expect(store.getMarkdownPlugins().math).toBe(fakes.math);
  });

  it("renders a diagram through the real plugin with the latest config", async () => {
    const store = await loadStore();
    const instance = store.getMarkdownPlugins().mermaid?.getMermaid({ theme: "base" });
    instance?.initialize({ theme: "dark" });

    await expect(instance?.render("id-1", "graph TD; A-->B;")).resolves.toEqual({
      svg: "<svg></svg>",
    });
    expect(fakes.configs).toEqual([{ theme: "dark" }]);
    expect(fakes.render).toHaveBeenCalledWith("id-1", "graph TD; A-->B;");
  });

  it("retries the mermaid plugin after its chunk failed to load", async () => {
    const store = await loadStore();
    fakes.failures.mermaid = 1;
    const mermaid = store.getMarkdownPlugins().mermaid;

    await expect(mermaid?.getMermaid().render("id-1", "graph TD;")).rejects.toThrow(
      "mermaid chunk failed",
    );
    await expect(mermaid?.getMermaid().render("id-2", "graph TD;")).resolves.toEqual({
      svg: "<svg></svg>",
    });
  });
});
