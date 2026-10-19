import { describe, expect, it, rstest } from "@rstest/core";
import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown";
import {
  createWorkerCodePlugin,
  type HighlightRequest,
  type HighlightResponse,
} from "./code-highlighter.js";

type Result = HighlightResponse["result"];

const OPTIONS: HighlightOptions = {
  code: "const a = 1;",
  language: "ts",
  themes: ["github-light", "github-dark"],
};

function resultFor(code: string): Result {
  return { tokens: [[{ content: code, offset: 0 }]], fg: "#000", bg: "#fff" } as Result;
}

class FakeWorker extends EventTarget {
  posted: HighlightRequest[] = [];
  terminated = false;
  postMessage(message: HighlightRequest) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  answer(id: number, result: Result) {
    this.dispatchEvent(new MessageEvent("message", { data: { id, result } }));
  }
}

function fakeFallback(): CodeHighlighterPlugin & { calls: HighlightOptions[] } {
  const calls: HighlightOptions[] = [];
  return {
    calls,
    name: "shiki",
    type: "code-highlighter",
    supportsLanguage: () => true,
    getSupportedLanguages: () => [],
    getThemes: () => ["github-light", "github-dark"],
    highlight(options) {
      calls.push(options);
      return resultFor(options.code);
    },
  };
}

function setup() {
  const worker = new FakeWorker();
  const fallback = fakeFallback();
  const plugin = createWorkerCodePlugin(() => worker as unknown as Worker, fallback);
  return { worker, fallback, plugin };
}

describe("createWorkerCodePlugin", () => {
  it("highlights in the worker and answers through the callback", () => {
    const { worker, fallback, plugin } = setup();
    const callback = rstest.fn();

    expect(plugin.highlight(OPTIONS, callback)).toBeNull();
    expect(worker.posted).toEqual([{ id: 0, options: OPTIONS }]);

    worker.answer(0, resultFor("worker"));
    expect(callback).toHaveBeenCalledWith(resultFor("worker"));
    expect(fallback.calls).toEqual([]);
  });

  it("returns a finished result synchronously without asking the worker again", () => {
    const { worker, plugin } = setup();
    plugin.highlight(OPTIONS);
    worker.answer(0, resultFor("worker"));

    expect(plugin.highlight(OPTIONS)).toEqual(resultFor("worker"));
    expect(worker.posted).toHaveLength(1);
  });

  it("sends one request for identical blocks and answers every caller", () => {
    const { worker, plugin } = setup();
    const first = rstest.fn();
    const second = rstest.fn();

    plugin.highlight(OPTIONS, first);
    plugin.highlight({ ...OPTIONS }, second);
    expect(worker.posted).toHaveLength(1);

    worker.answer(0, resultFor("worker"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("highlights on the main thread when no worker can be made", () => {
    const fallback = fakeFallback();
    const plugin = createWorkerCodePlugin(() => null, fallback);

    expect(plugin.highlight(OPTIONS)).toEqual(resultFor(OPTIONS.code));
    expect(fallback.calls).toEqual([OPTIONS]);
  });

  it("moves pending and later requests to the main thread when the worker fails", () => {
    const { worker, fallback, plugin } = setup();
    const callback = rstest.fn();
    plugin.highlight(OPTIONS, callback);

    worker.dispatchEvent(new Event("error"));

    expect(worker.terminated).toBe(true);
    expect(callback).toHaveBeenCalledWith(resultFor(OPTIONS.code));
    const later = { ...OPTIONS, code: "let b = 2;" };
    expect(plugin.highlight(later)).toEqual(resultFor(later.code));
    expect(worker.posted).toHaveLength(1);
    expect(fallback.calls).toEqual([OPTIONS, later]);
  });
});
