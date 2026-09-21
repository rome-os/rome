import { parseArgs } from "node:util";
import { connectComputer, defaultDeviceName } from "./connect.js";
import { isRecord, parseResponse } from "./actions.js";
import { readOptionalCallerCredential } from "./local.js";
import { cloudOrigin } from "./cloud.js";
import { authorizeServer, configureCaller } from "./auth.js";
import { callDaemon, daemonStatus, serveDaemon, startDaemon, stopDaemon } from "./daemon.js";
import { validId } from "./protocol.js";
import { commandHelp } from "./help.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      cloud: { type: "string" },
      name: { type: "string" },
      args: { type: "string" },
      server: { type: "boolean" },
    },
  });
  if (values.help || positionals.length === 0 || positionals[0] === "help") {
    const explicitTopic = positionals[0] === "help";
    process.stdout.write(
      commandHelp(explicitTopic ? positionals.slice(1) : positionals, explicitTopic),
    );
    return;
  }
  if (values.server && !(positionals[0] === "auth" && positionals.length === 1))
    throw new Error("--server is only supported by rome-node auth.");
  if (positionals[0] === "auth" && positionals[1] === "status" && positionals.length === 2) {
    const credential = await readOptionalCallerCredential();
    process.stdout.write(
      `${JSON.stringify(credential ? { configured: true, cloudUrl: credential.cloudUrl } : { configured: false })}\n`,
    );
    return;
  }
  if (positionals[0] === "auth" && positionals.length === 1) {
    const cloudUrl = cloudOrigin(values.cloud ?? "https://romeos.cc");
    if (values.server) {
      await authorizeServer(cloudUrl, process.env.ROME_INSTANCE_TOKEN);
      process.stdout.write(`${JSON.stringify({ configured: true })}\n`);
      return;
    }
    if (process.stdin.isTTY)
      throw new Error("Pass the communication token through stdin, not command arguments.");
    if (await daemonStatus())
      throw new Error("Stop the CLI daemon before changing credentials: rome-node daemon stop");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 1024) throw new Error("Invalid communication token.");
      chunks.push(buffer);
    }
    const token = Buffer.concat(chunks).toString("utf8").trim();
    await configureCaller(cloudUrl, token);
    process.stdout.write(`${JSON.stringify({ configured: true })}\n`);
    return;
  }
  if (positionals[0] === "daemon") {
    if (positionals.length > 2) throw new Error("Invalid daemon command.");
    const operation = positionals[1] ?? "start";
    if (operation === "serve") {
      await serveDaemon();
      return;
    }
    if (operation === "stop") {
      await stopDaemon();
      process.stdout.write(`${JSON.stringify({ running: false })}\n`);
      return;
    }
    if (operation !== "start" && operation !== "status") throw new Error("Unknown daemon command.");
    const state = operation === "start" ? await startDaemon() : await daemonStatus();
    process.stdout.write(
      `${JSON.stringify(state ? { running: true, pid: state.pid } : { running: false })}\n`,
    );
    return;
  }
  if (positionals[0] === "connect" && positionals.length === 1) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await connectComputer(
        values.cloud ?? "https://romeos.cc",
        values.name ?? defaultDeviceName(),
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return;
  }
  if (positionals[0] !== "device") throw new Error("Unknown command. Run rome-node --help.");
  const [, command, deviceId, action] = positionals;
  const listing = positionals.length === 1;
  if (
    !listing &&
    !(command === "describe" && positionals.length === 3) &&
    !(command === "run" && positionals.length === 4)
  )
    throw new Error("Invalid device command. Run rome-node --help.");
  if (!listing && !validId(deviceId)) throw new Error("Invalid device ID.");
  let args: unknown = {};
  if (values.args) {
    try {
      args = JSON.parse(values.args);
    } catch {
      throw new Error("--args must contain valid JSON.");
    }
  }
  const response = await callDaemon(
    listing ? "/devices" : "/run",
    listing
      ? undefined
      : { deviceId, action: command === "describe" ? "system.info" : action, args },
  );
  const body: unknown = await response.json();
  if (listing && response.ok && isRecord(body) && Array.isArray(body.items)) {
    process.stdout.write(`${JSON.stringify({ items: body.items })}\n`);
    return;
  }
  const result = parseResponse(body);
  if (!result) throw new Error("Invalid response from the CLI daemon.");
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (
    !result.ok ||
    !response.ok ||
    (isRecord(result.result) &&
      Object.hasOwn(result.result, "exitCode") &&
      result.result.exitCode !== 0)
  )
    process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Rome Node failed."}\n`);
  process.exitCode = 1;
});
