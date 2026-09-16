// Running one root script on the hosting VM, to completion, from inside Rome.
//
// `HostExecutionService` is reachable only from an action execution: it takes
// the job identity from the ambient execution context, and one job identity is
// one action execution. Rome-internal callers therefore go through the action
// rather than the service — fabricating an execution identity would route
// around the very thing host execution's trust boundary rests on (see
// docs/architecture/host-execution.md).
//
// Submission and completion are separate answers. The helper accepts a job
// durably and may still be running when the submit action returns, so anything
// that wants an outcome polls the accepted job by id. That is also why a lost
// response is never retried here: a repeat submission is a second root script,
// and the caller's own job id is the only safe thing to ask about.

import { createLogger } from "../logger.js";

const log = createLogger("root-script");

/** Poll cadence while an accepted job is still running on the host. */
const POLL_INTERVAL_MS = 2_000;

export interface RootScriptRequest {
  /** Noninteractive shell script, at most 64 KiB. */
  script: string;
  /** Why this host-root operation is needed. Recorded with the job. */
  reason: string;
  /** Host-side limit. The helper caps this; 600 seconds is its ceiling. */
  timeoutSeconds: number;
  interpreter?: "sh" | "bash";
}

export interface RootScriptOutcome {
  status: "succeeded" | "failed" | "cancelled" | "timed_out" | "unknown";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the helper cut the output at its configured ceiling. */
  truncated: boolean;
  jobId: string;
}

/**
 * Runs a script as root on the hosting VM and resolves once the host job
 * reaches a terminal state. A non-zero exit is an outcome, not a throw: callers
 * decide whether a failing script is fatal. Throws only when the script could
 * not be run at all — host execution disabled, helper unreachable, submission
 * outcome unknown.
 */
export interface RootScriptRunner {
  run(request: RootScriptRequest, signal?: AbortSignal): Promise<RootScriptOutcome>;
}

/** The slice of ActionEngine this needs, narrowed so tests need no engine. */
export interface RootScriptActionEngine {
  run(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ status: string; data?: unknown; error?: string }>;
}

interface HostJobShape {
  id: string;
  status: RootScriptOutcome["status"] | "queued" | "running";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  completed?: boolean;
}

export class RootScriptUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootScriptUnavailable";
  }
}

function asJob(value: unknown): HostJobShape | null {
  if (!value || typeof value !== "object") return null;
  const job = value as Partial<HostJobShape>;
  if (typeof job.id !== "string" || typeof job.status !== "string") return null;
  return {
    id: job.id,
    status: job.status,
    exitCode: typeof job.exitCode === "number" ? job.exitCode : null,
    stdout: typeof job.stdout === "string" ? job.stdout : "",
    stderr: typeof job.stderr === "string" ? job.stderr : "",
    truncated: job.truncated === true,
  };
}

/**
 * A failing host job is reported by the action as an error string with the job
 * snapshot appended as JSON. Recovering that snapshot keeps a failed script an
 * outcome the caller can read rather than an opaque message — the caller
 * usually wants the script's own stderr.
 */
function jobFromErrorString(error: string): HostJobShape | null {
  const brace = error.indexOf("{");
  if (brace === -1) return null;
  try {
    return asJob(JSON.parse(error.slice(brace)));
  } catch {
    return null;
  }
}

function terminal(job: HostJobShape): boolean {
  return job.status !== "queued" && job.status !== "running";
}

function outcome(job: HostJobShape): RootScriptOutcome {
  return {
    status: job.status as RootScriptOutcome["status"],
    exitCode: job.exitCode,
    stdout: job.stdout,
    stderr: job.stderr,
    truncated: job.truncated,
    jobId: job.id,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("root script wait cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The production runner: submit through `system:execute_root_script`, then poll
 * the accepted job with `system:manage_root_script` until it settles.
 */
export function createActionRootScriptRunner(engine: RootScriptActionEngine): RootScriptRunner {
  return {
    async run(request, signal): Promise<RootScriptOutcome> {
      const submitted = await engine.run("system:execute_root_script", {
        target: "hosting-vm",
        interpreter: request.interpreter ?? "bash",
        script: request.script,
        reason: request.reason,
        timeoutSeconds: request.timeoutSeconds,
      });

      let job: HostJobShape | null = null;
      if (submitted.status === "ok") {
        job = asJob(submitted.data);
      } else if (submitted.status === "error") {
        // A job that ran and failed still carries its snapshot; anything else
        // means the script never ran.
        job = jobFromErrorString(submitted.error ?? "");
        if (!job) throw new RootScriptUnavailable(submitted.error ?? "Host execution failed.");
      } else {
        throw new RootScriptUnavailable(
          `Host execution returned an unusable result (${submitted.status}).`,
        );
      }
      if (!job) throw new RootScriptUnavailable("Host execution returned no job.");

      log.info("root script submitted", { jobId: job.id, reason: request.reason });

      // The helper's own timeout bounds the script; this bounds the wait for a
      // helper that accepted the job and then stopped answering.
      const deadline = Date.now() + (request.timeoutSeconds + 60) * 1_000;
      while (!terminal(job)) {
        if (Date.now() > deadline) {
          throw new RootScriptUnavailable(
            `Host job ${job.id} never reported a terminal state. Inspect it with system:manage_root_script.`,
          );
        }
        await sleep(POLL_INTERVAL_MS, signal);
        const inspected = await engine.run("system:manage_root_script", {
          target: "hosting-vm",
          operation: "inspect",
          jobId: job.id,
        });
        const next =
          inspected.status === "ok"
            ? asJob(inspected.data)
            : jobFromErrorString(inspected.error ?? "");
        if (next) job = next;
      }

      log.info("root script finished", {
        jobId: job.id,
        status: job.status,
        exitCode: job.exitCode,
      });
      return outcome(job);
    },
  };
}
