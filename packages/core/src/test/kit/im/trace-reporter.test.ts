import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { traceIndexSchema } from "./trace.js";
import { ChannelTraceReporter } from "./trace-reporter.js";

describe("ChannelTraceReporter", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "channel-traces-"));
  });

  afterEach(() => rm(directory, { recursive: true, force: true }));

  const readIndex = async () =>
    traceIndexSchema.parse(JSON.parse(await readFile(join(directory, "index.json"), "utf8")));

  const result = (id: string, status: "pass" | "fail" | "skip") => ({
    testId: id,
    name: id,
    testPath: "/repo/a.test.ts",
    status,
    project: "core",
  });

  it("indexes every test with its outcome and the trace it recorded", async () => {
    const reporter = new ChannelTraceReporter(directory);
    reporter.onTestCaseResult({
      testId: "t1",
      name: "answers the user",
      parentNames: ["telegram"],
      testPath: "/repo/scenarios.integration.test.ts",
      status: "fail",
      duration: 12,
      errors: [{ message: 'Step "Rome answers": boom' }],
      project: "core",
      meta: { channelTrace: join(directory, "traces", "t1.json") },
    });
    reporter.onTestCaseResult({
      testId: "t2",
      name: "plain test",
      testPath: "/repo/other.test.ts",
      status: "pass",
      project: "core",
    });
    reporter.onTestRunEnd();

    expect((await readIndex()).tests).toEqual([
      {
        id: "t1",
        name: "telegram > answers the user",
        file: "/repo/scenarios.integration.test.ts",
        status: "fail",
        durationMs: 12,
        errors: ['Step "Rome answers": boom'],
        trace: join("traces", "t1.json"),
      },
      { id: "t2", name: "plain test", file: "/repo/other.test.ts", status: "pass", errors: [] },
    ]);
  });

  it("merges a partial rerun into the index, keeping what the run skipped", async () => {
    const first = new ChannelTraceReporter(directory);
    first.onTestCaseResult(result("t1", "fail"));
    first.onTestCaseResult(result("t2", "pass"));
    first.onTestRunEnd();

    const rerun = new ChannelTraceReporter(directory);
    rerun.onTestCaseResult(result("t1", "pass"));
    rerun.onTestCaseResult(result("t2", "skip"));
    rerun.onTestCaseResult(result("t3", "skip"));
    rerun.onTestRunEnd();

    expect((await readIndex()).tests.map((test) => [test.id, test.status])).toEqual([
      ["t1", "pass"],
      ["t2", "pass"],
      ["t3", "skip"],
    ]);
  });

  it("starts over from an index a killed run left half written", async () => {
    await writeFile(join(directory, "index.json"), '{"version":1,"tests":[{"id"');

    const reporter = new ChannelTraceReporter(directory);
    reporter.onTestCaseResult(result("t1", "pass"));
    reporter.onTestRunEnd();

    expect((await readIndex()).tests.map((test) => test.id)).toEqual(["t1"]);
  });
});
