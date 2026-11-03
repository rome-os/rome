/**
 * A stand-in for the `opencli browser <session> ...` commands the
 * browser-automation actions run. `eval` runs the expression in a node:vm
 * context that plays the page, so the page-side job code really executes.
 * `open` and `location.reload()` each start a fresh context, the way a
 * navigation discards the page's globals. `history.pushState` keeps it.
 */
import vm from "node:vm";
import type { OpencliResult, RunOpencli } from "../src/lib/browser-page.js";

export interface FakeOpencli {
  run: RunOpencli;
  /** Every argv the actions passed, in order. */
  calls: string[][];
  /** The subcommand of each call, such as "open" or "eval". */
  subcommands(): string[];
  /** Discards the page's globals, as a full navigation would. */
  navigate(url: string): void;
  /** Values the page scripts read as `globalThis.__test`. */
  readonly testGlobals: Record<string, unknown>;
}

export interface FakeOpencliOptions {
  /** Returned for `open` instead of opening a page. */
  openResult?: OpencliResult;
  /** Caps every page timer, so a twenty-second wait slice returns at once. */
  maxPageTimerMs?: number;
}

const OK = { code: 0, stderr: "" };

export function createFakeOpencli(options: FakeOpencliOptions = {}): FakeOpencli {
  const calls: string[][] = [];
  const testGlobals: Record<string, unknown> = {};
  const maxPageTimerMs = options.maxPageTimerMs ?? Number.POSITIVE_INFINITY;
  let page: vm.Context | null = null;

  const newDocument = (url: string): vm.Context => {
    const location = {
      href: url,
      reload: () => {
        page = newDocument(location.href);
      },
    };
    const context: Record<string, unknown> = {
      __test: testGlobals,
      console,
      document: { readyState: "complete" },
      setTimeout: (callback: () => void, ms = 0) =>
        setTimeout(callback, Math.min(ms, maxPageTimerMs)),
      location,
      history: {
        pushState: (_state: unknown, _unused: string, nextUrl: string) => {
          location.href = nextUrl;
        },
      },
    };
    return vm.createContext(context);
  };

  const run: RunOpencli = async (args) => {
    calls.push(args);
    const rest = args[0] === "--profile" ? args.slice(2) : args;
    const [root, , subcommand, value] = rest;
    if (root !== "browser") {
      return { code: 1, stdout: "", stderr: `unexpected command ${root}` };
    }

    if (subcommand === "open") {
      if (options.openResult) {
        return options.openResult;
      }
      page = newDocument(value);
      return { ...OK, stdout: `${JSON.stringify({ url: value, page: "TARGET-1" }, null, 2)}\n` };
    }

    if (subcommand === "eval") {
      if (!page) {
        return { code: 1, stdout: "", stderr: "No page is open in this session" };
      }
      try {
        const result: unknown = await vm.runInContext(value, page);
        const stdout = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { ...OK, stdout: `${stdout}\n` };
      } catch (error) {
        return {
          code: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (subcommand === "close") {
      page = null;
      return { ...OK, stdout: "Browser session tab lease released\n" };
    }

    return { code: 1, stdout: "", stderr: `unexpected subcommand ${subcommand}` };
  };

  return {
    run,
    calls,
    subcommands: () =>
      calls.map((args) => (args[0] === "--profile" ? args.slice(2) : args)[2] ?? ""),
    navigate: (url) => {
      page = newDocument(url);
    },
    testGlobals,
  };
}
