import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const socketPath = "/run/rome-host/control.sock";

function rpc(method, path, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: bytes
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) }
          : {},
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(data) });
          } catch (error) {
            reject(error);
          }
        });
        response.on("error", reject);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("Host RPC timeout")));
    req.on("error", reject);
    req.end(bytes);
  });
}

async function ready() {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const result = await rpc("GET", "/v1/capabilities");
      assert.equal(result.status, 200);
      assert.equal(result.body.hostId, "smoke-vm");
      assert.equal(result.body.enabled, true);
      assert.equal(result.body.protocolVersion, 1);
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError;
}

function submission(requestId, script, timeoutSeconds = 3) {
  return {
    requestId,
    hostId: "smoke-vm",
    interpreter: "sh",
    script,
    reason: "Isolated host execution integration check",
    timeoutSeconds,
    executionId: requestId,
    rootExecutionId: requestId,
  };
}

async function terminal(id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await rpc("GET", `/v1/jobs/${id}`);
    assert.equal(result.status, 200);
    if (!["queued", "running"].includes(result.body.status)) return result.body;
    await delay(100);
  }
  throw new Error(`Job ${id} did not finish`);
}

async function submit(body) {
  const result = await rpc("POST", "/v1/jobs", body);
  assert.ok([200, 202].includes(result.status), JSON.stringify(result));
  assert.equal(result.body.id, body.requestId);
  return result.body;
}

const rootJob = submission(
  "smoke-root",
  'id -u; printf "host-only" > /var/lib/rome-host/smoke-root-proof; printf "%s" "${HOST_EXECUTION_TEST_SECRET:-clean}"',
);

assert.equal(process.getuid(), 10001);
await ready();

if (process.argv[2] === "verify-restart") {
  const prior = await terminal(rootJob.requestId);
  const duplicate = await submit(rootJob);
  assert.equal(duplicate.status, "succeeded");
  assert.equal(duplicate.startedAt, prior.startedAt);
  assert.equal(duplicate.finishedAt, prior.finishedAt);
  console.log("Host job identity and result survived helper restart.");
} else {
  const wrongHost = await rpc("POST", "/v1/jobs", { ...rootJob, hostId: "another-vm" });
  assert.ok([400, 403, 409].includes(wrongHost.status));

  await submit(rootJob);
  const rootResult = await terminal(rootJob.requestId);
  assert.equal(rootResult.status, "succeeded");
  assert.equal(rootResult.stdout, "0\nclean");
  assert.equal(rootResult.exitCode, 0);

  const duplicate = await submit(rootJob);
  assert.equal(duplicate.startedAt, rootResult.startedAt);
  const collision = await rpc("POST", "/v1/jobs", { ...rootJob, script: "exit 1" });
  assert.equal(collision.status, 409);

  await submit(submission("smoke-failure", "printf failure >&2; exit 17"));
  const failed = await terminal("smoke-failure");
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 17);
  assert.equal(failed.stderr, "failure");

  await submit(submission("smoke-timeout", "sleep 20", 1));
  assert.equal((await terminal("smoke-timeout")).status, "timed_out");

  await submit(submission("smoke-cancel", "sleep 20"));
  assert.equal((await rpc("POST", "/v1/jobs/smoke-cancel/cancel")).status, 200);
  assert.equal((await terminal("smoke-cancel")).status, "cancelled");

  await submit(submission("smoke-output", "head -c 10000 /dev/zero | tr '\\0' x"));
  const output = await terminal("smoke-output");
  assert.equal(output.status, "succeeded");
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 1024);
  console.log("Nonroot client executed and managed bounded root jobs on the isolated host.");
}
