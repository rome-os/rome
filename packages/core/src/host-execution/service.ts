import { createHash } from "node:crypto";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { actionExecutionContext } from "../actions/context.js";
import { createLogger } from "../logger.js";

const log = createLogger("host-execution");
const admissionRejections = new Set(["busy", "retention_limit", "unavailable"]);
const jobIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const inputSchema = z.strictObject({
  target: z.literal("hosting-vm"),
  interpreter: z.enum(["sh", "bash"]),
  script: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 65_536),
  reason: z.string().trim().min(1).max(2_000),
  timeoutSeconds: z.number().int().min(1).max(600).default(60),
});
const capabilitiesSchema = z.object({
  protocolVersion: z.literal(1),
  version: z.string(),
  hostId: z.string().min(1),
  platform: z.literal("linux"),
  enabled: z.boolean(),
  interpreters: z.array(z.enum(["sh", "bash"])),
  maxTimeoutSeconds: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
});
const jobSchema = z.object({
  id: jobIdSchema,
  requestId: jobIdSchema,
  hostId: z.string().min(1),
  scriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "timed_out", "unknown"]),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export type RootScriptInput = z.input<typeof inputSchema>;
export type HostJob = z.infer<typeof jobSchema>;

export class HostExecutionError extends Error {
  constructor(
    message: string,
    readonly jobId?: string,
  ) {
    super(message);
    this.name = "HostExecutionError";
  }
}

class HostResponseError extends HostExecutionError {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export class HostExecutionService {
  constructor(private readonly config: { socketPath?: string; enabled: boolean }) {}

  /** Accepted jobs outlive Rome actions. Reconcile by job ID after a lost response, never submit a replacement automatically. */
  async start(rawInput: RootScriptInput): Promise<HostJob> {
    this.requireEnabled();
    const input = inputSchema.parse(rawInput);
    const context = actionExecutionContext.getStore();
    if (!context?.executionId || !context.rootExecutionId) {
      throw new HostExecutionError(
        "Root execution requires trusted Rome action execution context.",
      );
    }
    const jobId = createHash("sha256").update(context.executionId).digest("hex");
    const scriptSha256 = createHash("sha256").update(input.script).digest("hex");
    const capabilities = capabilitiesSchema.parse(await this.send("GET", "/v1/capabilities"));
    if (!capabilities.enabled) {
      throw new HostExecutionError("Root execution is disabled by the hosting VM owner.");
    }
    if (!capabilities.interpreters.includes(input.interpreter)) {
      throw new HostExecutionError(`The hosting VM does not support ${input.interpreter}.`);
    }
    if (input.timeoutSeconds > capabilities.maxTimeoutSeconds) {
      throw new HostExecutionError(
        `Host timeout limit is ${capabilities.maxTimeoutSeconds} seconds.`,
      );
    }
    const { target: _target, ...scriptInput } = input;
    const payload = {
      ...scriptInput,
      requestId: jobId,
      hostId: capabilities.hostId,
      executionId: context.executionId,
      rootExecutionId: context.rootExecutionId,
    };
    let snapshot: HostJob;
    try {
      snapshot = this.parseJob(
        await this.send("POST", "/v1/jobs", payload),
        jobId,
        capabilities.hostId,
        scriptSha256,
      );
    } catch (error) {
      if (
        error instanceof HostResponseError &&
        (error.statusCode < 500 ||
          (error.statusCode === 503 && admissionRejections.has(error.code)))
      ) {
        throw error;
      }
      // A transport or persistence failure can follow durable acceptance. GET is the only recovery request.
      try {
        snapshot = this.parseJob(
          await this.send("GET", `/v1/jobs/${jobId}`),
          jobId,
          capabilities.hostId,
          scriptSha256,
        );
      } catch {
        throw new HostExecutionError(
          `Host submission outcome is unknown. Inspect job ${jobId} with system:manage_root_script before considering another execution.`,
          jobId,
        );
      }
    }
    log.info("host job accepted", {
      jobId,
      hostId: snapshot.hostId,
      executionId: context.executionId,
      rootExecutionId: context.rootExecutionId,
      scriptSha256: snapshot.scriptSha256,
    });
    for (let attempt = 0; attempt < 4 && this.isPending(snapshot); attempt++) {
      await delay(250);
      try {
        snapshot = this.parseJob(
          await this.send("GET", `/v1/jobs/${jobId}`, undefined, 250),
          jobId,
          capabilities.hostId,
          scriptSha256,
        );
      } catch {
        // Acceptance is already known. A failed poll leaves the durable job available for explicit inspection.
        break;
      }
    }
    return snapshot;
  }

  async inspect(jobId: string): Promise<HostJob> {
    this.requireSocket();
    jobIdSchema.parse(jobId);
    return this.parseJob(await this.send("GET", `/v1/jobs/${jobId}`), jobId);
  }

  /** Cancellation is best effort for a managed process group. Unrestricted root scripts can escape it. */
  async cancel(jobId: string): Promise<HostJob> {
    this.requireSocket();
    jobIdSchema.parse(jobId);
    return this.parseJob(await this.send("POST", `/v1/jobs/${jobId}/cancel`), jobId);
  }

  private isPending(job: HostJob): boolean {
    return job.status === "queued" || job.status === "running";
  }

  private parseJob(value: unknown, jobId: string, hostId?: string, scriptSha256?: string): HostJob {
    const job = jobSchema.parse(value);
    if (job.id !== jobId || job.requestId !== jobId || (hostId && job.hostId !== hostId)) {
      throw new HostExecutionError("Host helper returned a job with mismatched identity.", jobId);
    }
    if (scriptSha256 && job.scriptSha256 !== scriptSha256) {
      throw new HostExecutionError(
        "Host helper returned a job with a different script hash.",
        jobId,
      );
    }
    return job;
  }

  private requireSocket(): string {
    if (!this.config.socketPath) {
      throw new HostExecutionError(
        "Host helper is not configured. Set ROME_HOST_EXECUTION_SOCKET to the mounted host control socket.",
      );
    }
    return this.config.socketPath;
  }

  private requireEnabled(): void {
    if (!this.config.enabled) {
      throw new HostExecutionError(
        "Root execution is disabled in Rome. The owner must explicitly set ROME_HOST_EXECUTION_ENABLED=true and enable the host policy.",
      );
    }
    this.requireSocket();
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 5_000,
  ): Promise<unknown> {
    const socketPath = this.requireSocket();
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method,
          path,
          headers:
            data === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(data),
                },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
              req.destroy(new HostExecutionError("Host helper response exceeded 2 MiB."));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const status = response.statusCode ?? 500;
              if (status < 200 || status >= 300) {
                const error = z.object({ error: z.string(), message: z.string() }).parse(parsed);
                reject(
                  new HostResponseError(
                    `Host helper ${error.error}: ${error.message}`,
                    status,
                    error.error,
                  ),
                );
              } else {
                resolve(parsed);
              }
            } catch {
              reject(new HostExecutionError("Host helper returned an invalid JSON response."));
            }
          });
        },
      );
      // A wall-clock deadline bounds trickling responses as well as idle connections.
      const timer = setTimeout(
        () => req.destroy(new HostExecutionError("Host helper request timed out.")),
        timeoutMs,
      );
      req.on("close", () => clearTimeout(timer));
      req.on("error", (error) =>
        reject(new HostExecutionError(`Host helper is unavailable: ${error.message}`)),
      );
      req.end(data);
    });
  }
}
