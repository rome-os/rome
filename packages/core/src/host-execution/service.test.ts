import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { actionExecutionContext } from "../actions/context.js";
import { HostExecutionService, type HostJob, type RootScriptInput } from "./service.js";
import { createAction } from "../../../../rome_apps/system/src/actions/execute-root-script/index.js";

const input: RootScriptInput = {
  target: "hosting-vm",
  interpreter: "sh",
  script: "printf hello",
  reason: "Verify the host helper",
  timeoutSeconds: 60,
};
const jobId = createHash("sha256").update("execution-1").digest("hex");
const completed: HostJob = {
  id: jobId,
  requestId: jobId,
  hostId: "host-1",
  scriptSha256: createHash("sha256").update(input.script).digest("hex"),
  status: "succeeded",
  exitCode: 0,
  stdout: "hello",
  stderr: "",
  truncated: false,
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:00:01Z",
};
const capabilities = {
  protocolVersion: 1,
  version: "0.1.0",
  hostId: "host-1",
  platform: "linux",
  enabled: true,
  interpreters: ["sh", "bash"],
  maxTimeoutSeconds: 600,
  maxOutputBytes: 131_072,
};

const resources: Array<{ server: Server; directory: string }> = [];

async function helper(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const directory = await mkdtemp("/tmp/rome-host-test-");
  const socketPath = join(directory, "control.sock");
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  resources.push({ server, directory });
  return { service: new HostExecutionService({ socketPath, enabled: true }), socketPath };
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}

function start(service: HostExecutionService, value = input) {
  return actionExecutionContext.run(
    {
      executionId: "execution-1",
      rootExecutionId: "root-1",
      initiator: "test",
    },
    () => service.start(value),
  );
}

afterEach(async () => {
  for (const { server, directory } of resources.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

describe("HostExecutionService over HTTP Unix socket", () => {
  it("carries action execution context across the system action boundary", async () => {
    let submission: unknown;
    const { service } = await helper((request, response) => {
      if (request.url === "/v1/capabilities") return json(response, capabilities);
      void readBody(request).then((body) => {
        submission = body;
        json(response, completed);
      });
    });
    const action = createAction(
      {
        name: "execute_root_script",
        type: "system",
        description: "Host execution",
        complexity: "complex",
        speed: "moderate",
        reliability: "medium",
        sideEffects: "write",
      },
      { hostExecution: service },
    );
    const result = await actionExecutionContext.run(
      {
        executionId: "execution-1",
        rootExecutionId: "root-1",
        initiator: "test",
      },
      () => action.execute(input),
    );
    expect(result).toMatchObject({ status: "ok", data: { stdout: "hello", completed: true } });
    expect(submission).toMatchObject({
      requestId: jobId,
      executionId: "execution-1",
      rootExecutionId: "root-1",
    });
  });
  it("submits trusted execution metadata and reuses the same deterministic ID on retry", async () => {
    const submissions: unknown[] = [];
    const { service } = await helper((request, response) => {
      if (request.url === "/v1/capabilities") return json(response, capabilities);
      void readBody(request).then((body) => {
        submissions.push(body);
        json(response, completed, submissions.length === 1 ? 202 : 200);
      });
    });
    expect(await start(service)).toEqual(completed);
    expect(await start(service)).toEqual(completed);
    expect(submissions).toEqual(
      [0, 1].map(() => ({
        interpreter: "sh",
        script: input.script,
        reason: input.reason,
        timeoutSeconds: 60,
        requestId: jobId,
        hostId: "host-1",
        executionId: "execution-1",
        rootExecutionId: "root-1",
      })),
    );
  });

  it("requires both Core opt-in and a configured socket", async () => {
    await expect(start(new HostExecutionService({ enabled: false }))).rejects.toThrow(
      "disabled in Rome",
    );
    await expect(start(new HostExecutionService({ enabled: true }))).rejects.toThrow(
      "not configured",
    );
  });

  it("fails readably when the helper is missing", async () => {
    await expect(
      start(
        new HostExecutionService({
          enabled: true,
          socketPath: "/tmp/rome-host-nonexistent/control.sock",
        }),
      ),
    ).rejects.toThrow("Host helper is unavailable");
  });

  it("honors host disablement and timeout policy without submitting", async () => {
    let requests = 0;
    const { service } = await helper((_request, response) => {
      requests++;
      json(response, { ...capabilities, enabled: false });
    });
    await expect(start(service)).rejects.toThrow("disabled by the hosting VM owner");
    expect(requests).toBe(1);
    const limited = await helper((_request, response) =>
      json(response, { ...capabilities, maxTimeoutSeconds: 10 }),
    );
    await expect(start(limited.service)).rejects.toThrow("Host timeout limit is 10 seconds");
  });

  it("rejects missing trusted context, caller metadata, arbitrary targets, and oversized UTF-8 before transport", async () => {
    const service = new HostExecutionService({ enabled: true, socketPath: "/missing" });
    await expect(service.start(input)).rejects.toThrow("trusted Rome action execution context");
    await expect(
      start(service, { ...input, executionId: "forged" } as RootScriptInput),
    ).rejects.toThrow();
    await expect(
      start(service, { ...input, target: "other" } as unknown as RootScriptInput),
    ).rejects.toThrow();
    await expect(start(service, { ...input, script: "é".repeat(40_000) })).rejects.toThrow();
  });

  it("reconciles a lost submission response with GET and never automatically resubmits", async () => {
    const requests: string[] = [];
    const { service } = await helper((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url === "/v1/capabilities") return json(response, capabilities);
      if (request.method === "POST") return request.socket.destroy();
      json(response, completed);
    });
    expect(await start(service)).toEqual(completed);
    expect(requests).toEqual(["GET /v1/capabilities", "POST /v1/jobs", `GET /v1/jobs/${jobId}`]);
  });

  it("returns the lookup ID when both submission and reconciliation are uncertain", async () => {
    let posts = 0;
    const { service } = await helper((request, response) => {
      if (request.url === "/v1/capabilities") return json(response, capabilities);
      if (request.method === "POST") {
        posts++;
        return request.socket.destroy();
      }
      json(response, { error: "not_found", message: "Job not found" }, 404);
    });
    await expect(start(service)).rejects.toMatchObject({
      jobId,
      message: expect.stringContaining("outcome is unknown"),
    });
    expect(posts).toBe(1);
  });

  it("preserves an unknown restart outcome without resubmission", async () => {
    let posts = 0;
    const { service } = await helper((request, response) => {
      if (request.url === "/v1/capabilities") return json(response, capabilities);
      posts++;
      json(response, { ...completed, status: "unknown", exitCode: null });
    });
    expect(await start(service)).toMatchObject({ status: "unknown" });
    expect(posts).toBe(1);
  });

  it("does not report an old script as success when a conflicting submission response is lost", async () => {
    let posts = 0;
    const { service } = await helper((request, response) => {
      if (request.url === "/v1/capabilities") return json(response, capabilities);
      if (request.method === "POST") {
        posts++;
        return request.socket.destroy();
      }
      json(response, { ...completed, scriptSha256: "f".repeat(64) });
    });
    await expect(start(service)).rejects.toMatchObject({
      jobId,
      message: expect.stringContaining("outcome is unknown"),
    });
    expect(posts).toBe(1);
  });

  it("reports payload conflicts without retrying or returning the existing job as success", async () => {
    const requests: string[] = [];
    const { service } = await helper((request, response) => {
      requests.push(request.method!);
      if (request.url === "/v1/capabilities") return json(response, capabilities);
      json(response, { error: "conflict", message: "Different payload" }, 409);
    });
    await expect(start(service)).rejects.toThrow("Different payload");
    expect(requests).toEqual(["GET", "POST"]);
  });

  it("polls accepted jobs briefly and returns the running snapshot", async () => {
    let polls = 0;
    const { service } = await helper((request, response) => {
      if (request.url === "/v1/capabilities") return json(response, capabilities);
      if (request.method === "GET") polls++;
      json(response, { ...completed, status: "running", exitCode: null, finishedAt: null });
    });
    expect(await start(service)).toMatchObject({ status: "running" });
    expect(polls).toBe(4);
  });

  it("inspects and cancels accepted jobs after Core enablement is switched off", async () => {
    const requests: string[] = [];
    const { socketPath } = await helper((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      json(response, { ...completed, status: "cancelled", exitCode: null });
    });
    const service = new HostExecutionService({ socketPath, enabled: false });
    await expect(service.inspect(jobId)).resolves.toMatchObject({ status: "cancelled" });
    await expect(service.cancel(jobId)).resolves.toMatchObject({ status: "cancelled" });
    expect(requests).toEqual([`GET /v1/jobs/${jobId}`, `POST /v1/jobs/${jobId}/cancel`]);
    await expect(service.inspect("../other")).rejects.toThrow();
  });

  it("validates response identity and bounds response bytes", async () => {
    const mismatched = await helper((_request, response) =>
      json(response, { ...completed, id: "wrong" }),
    );
    await expect(mismatched.service.inspect(jobId)).rejects.toThrow("mismatched identity");
    const oversized = await helper((_request, response) =>
      json(response, { ...completed, stdout: "x".repeat(2 * 1024 * 1024) }),
    );
    await expect(oversized.service.inspect(jobId)).rejects.toThrow();
  });
});
