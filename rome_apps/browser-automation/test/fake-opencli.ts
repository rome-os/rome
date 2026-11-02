/**
 * A stand-in for the `opencli browser <command> --session <session>` commands
 * the browser-automation actions run. `eval` runs the expression in a node:vm
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
  /** The `--session` value of each call. */
  sessions(): string[];
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
  /**
   * Prints results the way OpenCLI 1.8 did: an eval's string result as is,
   * and failures as text on stderr. By default results are OpenCLI 2's
   * `{"ok":true,"data":...}` lines, and failures its error envelope on stdout.
   */
  legacyOutput?: boolean;
}

interface ParsedCall {
  subcommand: string;
  value: string | undefined;
  session: string | undefined;
}

function parseCall(args: string[]): ParsedCall | null {
  const rest = args[0] === "--profile" ? args.slice(2) : args;
  if (rest[0] !== "browser") {
    return null;
  }
  const positionals: string[] = [];
  let session: string | undefined;
  for (let index = 1; index < rest.length; index += 1) {
    if (rest[index] === "--session") {
      session = rest[index + 1];
      index += 1;
    } else {
      positionals.push(rest[index]);
    }
  }
  return { subcommand: positionals[0] ?? "", value: positionals[1], session };
}

export function createFakeOpencli(options: FakeOpencliOptions = {}): FakeOpencli {
  const calls: string[][] = [];
  const testGlobals: Record<string, unknown> = {};
  const maxPageTimerMs = options.maxPageTimerMs ?? Number.POSITIVE_INFINITY;
  const legacy = options.legacyOutput ?? false;
  let page: vm.Context | null = null;

  const succeed = (data: unknown, legacyText: string): OpencliResult => ({
    code: 0,
    stderr: "",
    stdout: `${legacy ? legacyText : JSON.stringify({ ok: true, data })}\n`,
  });
  const fail = (code: string, message: string): OpencliResult =>
    legacy
      ? { code: 1, stdout: "", stderr: message }
      : {
          code: 1,
          stdout: `${JSON.stringify({ ok: false, error: { code, message, exitCode: 1 } })}\n`,
          stderr: "",
        };

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
    const call = parseCall(args);
    if (!call) {
      return fail("usage_error", `unexpected command ${args.join(" ")}`);
    }
    if (!call.session) {
      return fail("usage_error", "Page commands require --session <name>.");
    }

    if (call.subcommand === "open") {
      if (options.openResult) {
        return options.openResult;
      }
      const url = call.value ?? "";
      page = newDocument(url);
      const data = { url, page: "TARGET-1" };
      return succeed(data, JSON.stringify(data, null, 2));
    }

    if (call.subcommand === "eval") {
      if (!page) {
        return fail("COMMAND_EXEC", "No page is open in this session");
      }
      try {
        const result: unknown = await vm.runInContext(call.value ?? "", page);
        return succeed(
          result,
          typeof result === "string" ? result : JSON.stringify(result, null, 2),
        );
      } catch (error) {
        // OpenCLI 2 reports a page exception as an UNKNOWN error with its stack.
        const message =
          error instanceof Error
            ? `${error.name}: ${error.message}\n    at <anonymous>:1:1`
            : String(error);
        return legacy ? fail("UNKNOWN", String(error)) : fail("UNKNOWN", message);
      }
    }

    if (call.subcommand === "close") {
      page = null;
      return succeed("Browser session tab lease released", "Browser session tab lease released");
    }

    return fail("usage_error", `unexpected subcommand ${call.subcommand}`);
  };

  return {
    run,
    calls,
    subcommands: () => calls.map((args) => parseCall(args)?.subcommand ?? ""),
    sessions: () => calls.map((args) => parseCall(args)?.session ?? ""),
    navigate: (url) => {
      page = newDocument(url);
    },
    testGlobals,
  };
}
