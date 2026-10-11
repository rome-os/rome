import { parseArgs } from "node:util";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { isRecord, cloudOrigin, validId, type ActionResponse } from "@rome-os/node-core";
import { authorizeServer, configureCaller } from "@rome-os/node-core/auth";
import {
  createNodeClient,
  CallerConfigurationError,
  DeviceActionError,
  nodeConfigFromEnvironment,
  readOptionalCallerCredential,
  daemonStatus,
  startDaemon,
  stopDaemon,
} from "@rome-os/node-core/client";
import { commandHelp } from "./help.js";
import { copyRequest } from "./copy.js";

const failed = (response: ActionResponse) =>
  !response.ok ||
  (isRecord(response.result) &&
    Object.hasOwn(response.result, "exitCode") &&
    response.result.exitCode !== 0);

async function readInput(path: string): Promise<Uint8Array> {
  if (path !== "-") return readFile(path);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function write(stream: NodeJS.WriteStream, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) =>
    stream.write(data, (error) => (error ? reject(error) : resolve())),
  );
}

function progressPrinter() {
  const started = Date.now();
  let last = 0;
  const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  return (progress: { bytes: number; total: number }, final = false) => {
    const now = Date.now();
    if (!final && now - last < 1000 && progress.bytes !== progress.total) return;
    last = now;
    const percent = progress.total ? Math.floor((progress.bytes / progress.total) * 100) : 100;
    const ms = now - started;
    const rate = ms ? mib((progress.bytes / ms) * 1000) : "0.0";
    const line = `${mib(progress.bytes)} / ${mib(progress.total)} MiB (${percent}%) ${rate} MiB/s`;
    process.stderr.write(
      process.stderr.isTTY ? `\r${line}\x1b[K${final ? "\n" : ""}` : `${line}\n`,
    );
  };
}

async function withShutdown(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await run(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      cloud: { type: "string" },
      name: { type: "string" },
      args: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      server: { type: "boolean" },
      "device-code": { type: "boolean" },
    },
  });
  if (values.help || positionals.length === 0 || positionals[0] === "help") {
    const explicitTopic = positionals[0] === "help";
    process.stdout.write(
      commandHelp(explicitTopic ? positionals.slice(1) : positionals, explicitTopic),
    );
    return;
  }
  const config = nodeConfigFromEnvironment(process.env);
  if (values.server && !(positionals[0] === "auth" && positionals.length === 1))
    throw new Error("--server is only supported by rome-node auth.");
  if (values["device-code"] && !(positionals[0] === "connect" && positionals.length === 1))
    throw new Error("--device-code is only supported by rome-node connect.");
  if (
    (values.input !== undefined || values.output !== undefined) &&
    !(positionals[0] === "device" && positionals[1] === "run")
  )
    throw new Error("--input and --output are only supported by rome-node device run.");
  if (positionals[0] === "cp") {
    if (positionals.length !== 3) throw new Error("Usage: rome-node cp <src> <dst>");
    const request = copyRequest(positionals[1], positionals[2], process.cwd());
    const client = createNodeClient(config);
    const print = progressPrinter();
    try {
      const summary = await client.copy(request, { onProgress: (progress) => print(progress) });
      print({ bytes: summary.bytes, total: summary.bytes }, true);
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } finally {
      client.disconnect();
    }
    return;
  }
  if (positionals[0] === "auth" && positionals[1] === "status" && positionals.length === 2) {
    const credential = await readOptionalCallerCredential(config);
    process.stdout.write(
      `${JSON.stringify(credential ? { configured: true, cloudUrl: credential.cloudUrl } : { configured: false })}\n`,
    );
    return;
  }
  if (positionals[0] === "auth" && positionals.length === 1) {
    const cloudUrl = cloudOrigin(values.cloud ?? "https://romeos.cc");
    if (values.server) {
      await authorizeServer(cloudUrl, process.env.ROME_INSTANCE_TOKEN, config, () => {
        process.stderr.write(
          "Rome Cloud is temporarily unavailable. Retrying server authorization.\n",
        );
      });
      process.stdout.write(`${JSON.stringify({ configured: true })}\n`);
      return;
    }
    if (process.stdin.isTTY)
      throw new Error("Pass the communication token through stdin, not command arguments.");
    if (await daemonStatus(config))
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
    await configureCaller(cloudUrl, token, config);
    process.stdout.write(`${JSON.stringify({ configured: true })}\n`);
    return;
  }
  if (positionals[0] === "daemon") {
    if (positionals.length > 2) throw new Error("Invalid daemon command.");
    const operation = positionals[1] ?? "start";
    if (operation === "serve") {
      const { serveDaemon } = await import("@rome-os/node-core/daemon");
      await withShutdown((signal) => serveDaemon(config, signal));
      return;
    }
    if (operation === "stop") {
      await stopDaemon(config);
      process.stdout.write(`${JSON.stringify({ running: false })}\n`);
      return;
    }
    if (operation !== "start" && operation !== "status") throw new Error("Unknown daemon command.");
    const state = operation === "start" ? await startDaemon(config) : await daemonStatus(config);
    process.stdout.write(
      `${JSON.stringify(state ? { running: true, pid: state.pid } : { running: false })}\n`,
    );
    return;
  }
  if (positionals[0] === "watch" && positionals.length === 1) {
    await withShutdown(async (signal) => {
      const client = createNodeClient(config);
      let finish!: () => void;
      const stopped = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stop = () => {
        client.disconnect();
        finish();
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        if (signal.aborted) return;
        await client.subscribe("connection", (event) =>
          process.stdout.write(`${JSON.stringify(event)}\n`),
        );
        await stopped;
      } finally {
        signal.removeEventListener("abort", stop);
        client.disconnect();
      }
    });
    return;
  }
  if (positionals[0] === "connect" && positionals.length === 1) {
    const {
      connectHost,
      defaultDeviceName,
      loginDevice,
      loginDeviceCode,
      createFileCredentialStore,
    } = await import("@rome-os/node-core/host");
    const name = values.name ?? defaultDeviceName();
    await withShutdown((signal) =>
      connectHost({
        cloudUrl: values.cloud ?? "https://romeos.cc",
        name,
        signal,
        credentials: createFileCredentialStore(join(config.directory, "credential.json")),
        authorize: (origin, deviceName, abort) =>
          values["device-code"]
            ? loginDeviceCode(origin, deviceName, abort, (prompt) => {
                process.stderr.write(
                  `Open this URL in a browser on another device:\n${prompt.verificationUri}\n` +
                    `User code: ${prompt.userCode}\n` +
                    `Or open: ${prompt.verificationUriComplete}\n` +
                    `Expires in ${prompt.expiresIn} seconds. Waiting for approval. Ctrl+C cancels.\n`,
                );
              })
            : loginDevice(origin, deviceName, abort, (url) => {
                process.stderr.write(
                  `Open this URL in your browser to authorize ${deviceName}:\n${url}\n`,
                );
              }),
        onEvent: (event) => {
          if (event.type === "authorization_required")
            process.stderr.write(
              "While connect is running, Rome instances in your account can execute programs and read or change files as your OS user.\n",
            );
          else if (event.type === "retrying")
            process.stderr.write("Rome Cloud is unavailable; keeping credentials and retrying.\n");
          else if (event.type === "device")
            process.stderr.write(`Device: ${event.name}\nDevice ID: ${event.deviceId}\n`);
          else process.stderr.write(`Connection: ${event.status}\n`);
        },
      }),
    );
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
  const client = createNodeClient(config);
  try {
    if (listing) {
      process.stdout.write(`${JSON.stringify(await client.listDevices())}\n`);
      return;
    }
    if (values.input !== undefined || values.output !== undefined) {
      const output = values.output ?? "-";
      const input = values.input === undefined ? undefined : await readInput(values.input);
      const { response, body } = await client.runBinary(deviceId, action, args, input);
      // A failed action leaves an existing output file unchanged.
      if (output === "-") await write(process.stdout, body);
      else if (response.ok) await writeFile(output, body);
      await write(
        output === "-" ? process.stderr : process.stdout,
        `${JSON.stringify(response)}\n`,
      );
      if (failed(response)) process.exitCode = 1;
      return;
    }
    const result =
      command === "describe"
        ? await client.describe(deviceId)
        : await client.run(deviceId, action, args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (failed(result)) process.exitCode = 1;
  } finally {
    client.disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof DeviceActionError) {
    process.stdout.write(`${JSON.stringify(error.response)}\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof CallerConfigurationError) {
    const messages = {
      not_configured:
        "Configure a communication token with rome-node auth --cloud <origin> using stdin first.",
      daemon_running: "Stop the CLI daemon before changing credentials: rome-node daemon stop",
      instance_token_required:
        "Server authorization requires ROME_INSTANCE_TOKEN in the environment.",
    };
    process.stderr.write(`${messages[error.code]}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : "Rome Node failed."}\n`);
  process.exitCode = 1;
});
