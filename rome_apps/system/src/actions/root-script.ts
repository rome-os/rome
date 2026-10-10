import type { ActionResult } from "@rome-os/app-runtime";

export interface RootScriptInput {
  target: "hosting-vm";
  interpreter: "sh" | "bash";
  script: string;
  reason: string;
  timeoutSeconds: number;
}

export interface HostJob {
  id: string;
  requestId: string;
  hostId: string;
  scriptSha256: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "unknown";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface HostExecutionDeps {
  hostExecution?: {
    start(input: RootScriptInput): Promise<HostJob>;
    inspect(jobId: string): Promise<HostJob>;
    cancel(jobId: string): Promise<HostJob>;
  };
}

export function hostJobResult(job: HostJob): ActionResult {
  const pending = job.status === "queued" || job.status === "running";
  const data = {
    ...job,
    target: "hosting-vm",
    completed: !pending && job.status !== "unknown",
    ...(pending && {
      message:
        "Accepted by the hosting VM. The script is still running. Inspect or cancel this job with system:manage_root_script. Stopping the Rome action or agent does not cancel this job.",
    }),
  };
  if (!pending && (job.status !== "succeeded" || job.exitCode !== 0)) {
    const message =
      job.status === "unknown"
        ? `Host job ${job.id} has an unknown outcome. Inspect host state before starting another script.`
        : `Host job ${job.id} ${job.status} (exit code ${job.exitCode ?? "unavailable"}).`;
    return {
      status: "error",
      error: `${message}\n${JSON.stringify(data)}`,
    };
  }
  return { status: "ok", data };
}

export function hostExecutionError(error: unknown): ActionResult {
  const message = error instanceof Error ? error.message : String(error);
  const jobId =
    error instanceof Error && "jobId" in error && typeof error.jobId === "string"
      ? error.jobId
      : undefined;
  return {
    status: "error",
    error: jobId
      ? `${message}\n${JSON.stringify({ jobId, target: "hosting-vm", completed: false })}`
      : message,
  };
}
