import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Reporter, TestResult } from "@rstest/core";
import { TRACE_META_KEY, TRACE_VERSION, type TraceIndex, traceIndexSchema } from "./trace.js";

type IndexedTest = TraceIndex["tests"][number];

/**
 * Writes `index.json` into `directory` when a run ends: every test with its
 * outcome, and the trace file a channel scenario wrote for it. Traces
 * themselves are written by the scenarios, under the same directory, so the
 * index names them by relative path.
 *
 * A run merges into the index already there, so rerunning one test (`-t`, or
 * a watch rerun) keeps every other test's last result. A test the run skipped
 * keeps its earlier entry. To start over, delete `index.json` before the run.
 */
export class ChannelTraceReporter implements Reporter {
  private readonly tests: IndexedTest[] = [];

  constructor(private readonly directory: string) {}

  onTestCaseResult(result: TestResult): void {
    const trace = result.meta?.[TRACE_META_KEY];
    this.tests.push({
      id: result.testId,
      name: [...(result.parentNames ?? []), result.name].join(" > "),
      file: result.testPath,
      status: result.status,
      ...(result.duration !== undefined ? { durationMs: result.duration } : {}),
      errors: (result.errors ?? []).map((error) => error.message),
      ...(typeof trace === "string" ? { trace: relative(this.directory, trace) } : {}),
    });
  }

  onTestRunEnd(): void {
    const file = join(this.directory, "index.json");
    const merged = new Map(readIndex(file).map((test) => [test.id, test]));
    for (const test of this.tests.splice(0)) {
      if (test.status === "skip" && merged.has(test.id)) continue;
      merged.set(test.id, test);
    }
    const index: TraceIndex = {
      version: TRACE_VERSION,
      finishedAt: new Date().toISOString(),
      tests: [...merged.values()],
    };
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`);
  }
}

/** The tests of the index at `file`, or none when it is missing, unreadable or
 *  from another trace version. */
function readIndex(file: string): IndexedTest[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = traceIndexSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data.tests : [];
  } catch {
    // A half-written index from an interrupted run is not worth failing this one.
    return [];
  }
}
