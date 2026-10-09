import { afterEach, beforeEach, describe, expect, it, rstest } from "@rstest/core";
import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown";
import {
  createWorkerCodePlugin,
  type HighlightRequest,
  type HighlightResponse,
} from "./code-highlighter.js";

type Result = NonNullable<HighlightResponse["result"]>;

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
  answer(id: number, result: Result | null) {
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
  beforeEach(() => {
    rstest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    rstest.restoreAllMocks();
  });

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

  it("highlights on the main thread when the worker leaves a request unanswered", () => {
    rstest.useFakeTimers();
    try {
      const { worker, fallback, plugin } = setup();
      const callback = rstest.fn();
      plugin.highlight(OPTIONS, callback);

      rstest.advanceTimersByTime(19_999);
      expect(callback).not.toHaveBeenCalled();

      rstest.advanceTimersByTime(1);
      expect(fallback.calls).toEqual([OPTIONS]);
      expect(callback).toHaveBeenCalledWith(resultFor(OPTIONS.code));

      expect(worker.terminated).toBe(true);
      const later = { ...OPTIONS, code: "let b = 2;" };
      expect(plugin.highlight(later)).toEqual(resultFor(later.code));
      expect(worker.posted).toHaveLength(1);
    } finally {
      rstest.useRealTimers();
    }
  });

  it("keeps a worker that is still answering a backlog", () => {
    rstest.useFakeTimers();
    try {
      const { worker, fallback, plugin } = setup();
      const second = rstest.fn();
      plugin.highlight(OPTIONS);
      plugin.highlight({ ...OPTIONS, code: "let b = 2;" }, second);

      rstest.advanceTimersByTime(15_000);
      worker.answer(0, resultFor("first"));
      rstest.advanceTimersByTime(15_000);
      expect(worker.terminated).toBe(false);

      rstest.advanceTimersByTime(5_000);
      expect(worker.terminated).toBe(true);
      expect(fallback.calls).toEqual([{ ...OPTIONS, code: "let b = 2;" }]);
      expect(second).toHaveBeenCalledWith(resultFor("let b = 2;"));
    } finally {
      rstest.useRealTimers();
    }
  });

  it("highlights on the main thread when the worker could not highlight a block", () => {
    const { worker, fallback, plugin } = setup();
    const callback = rstest.fn();
    plugin.highlight(OPTIONS, callback);

    worker.answer(0, null);

    expect(fallback.calls).toEqual([OPTIONS]);
    expect(callback).toHaveBeenCalledWith(resultFor(OPTIONS.code));
    expect(worker.terminated).toBe(true);
  });

  it("moves to the main thread when the page cannot read the worker's answer", () => {
    const { worker, fallback, plugin } = setup();
    const callback = rstest.fn();
    plugin.highlight(OPTIONS, callback);

    worker.dispatchEvent(new MessageEvent("messageerror"));

    expect(worker.terminated).toBe(true);
    expect(fallback.calls).toEqual([OPTIONS]);
    expect(callback).toHaveBeenCalledWith(resultFor(OPTIONS.code));
  });

  it("highlights on the main thread when the worker cannot receive a request", () => {
    const { worker, fallback, plugin } = setup();
    worker.postMessage = () => {
      throw new DOMException("could not be cloned", "DataCloneError");
    };

    expect(plugin.highlight(OPTIONS)).toEqual(resultFor(OPTIONS.code));
    expect(fallback.calls).toEqual([OPTIONS]);
    expect(plugin.highlight(OPTIONS)).toEqual(resultFor(OPTIONS.code));
    expect(worker.terminated).toBe(false);
  });

  it("keeps only the most recent results", () => {
    const { worker, plugin } = setup();
    for (let i = 0; i <= 200; i++) {
      plugin.highlight({ ...OPTIONS, code: `line ${i}` });
      worker.answer(i, resultFor(`line ${i}`));
    }

    expect(plugin.highlight({ ...OPTIONS, code: "line 200" })).toEqual(resultFor("line 200"));
    expect(plugin.highlight({ ...OPTIONS, code: "line 0" })).toBeNull();
    expect(worker.posted).toHaveLength(202);
  });
});
