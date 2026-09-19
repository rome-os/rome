import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { actionError, isRecord, type ActionResponse } from "./actions.js";
import {
  byteLength,
  MAX_MESSAGE_BYTES,
  type InboundEnvelope,
  type OutboundEnvelope,
} from "./protocol.js";

export function createExecutor(
  name: string,
  send: (message: OutboundEnvelope) => boolean,
  secrets: string[] = [],
) {
  const children = new Set<ChildProcess>();
  let generation = 0;
  const handlers: Record<string, (args: unknown) => Promise<ActionResponse>> = {
    "system.info": async () => ({
      type: "response",
      ok: true,
      result: {
        name,
        platform:
          platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : platform(),
        actions: ["system.info", "exec"],
      },
    }),
    exec: async (input) => {
      if (
        !isRecord(input) ||
        typeof input.command !== "string" ||
        !input.command ||
        input.command.includes("\0") ||
        (input.args !== undefined &&
          (!Array.isArray(input.args) ||
            !input.args.every((arg) => typeof arg === "string" && !arg.includes("\0")))) ||
        (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.includes("\0")))
      )
        return actionError(
          "invalid_args",
          "exec requires command, optional string args[], and optional cwd.",
        );
      if (children.size >= 8)
        return actionError("busy", "The computer is already running eight programs.");
      const command = input.command;
      const args = (input.args ?? []) as string[];
      const cwd = input.cwd as string | undefined;
      return new Promise((resolve) => {
        const environment = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^(?:ROME_.*(?:TOKEN|SECRET|CREDENTIAL)|NODE_OPTIONS)$/i.test(key),
          ),
        );
        let child: ChildProcess;
        try {
          child = spawn(command, args, {
            cwd,
            env: environment,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          resolve(actionError("exec_failed", "Could not start the program."));
          return;
        }
        children.add(child);
        const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        const truncated = { stdout: false, stderr: false };
        for (const stream of ["stdout", "stderr"] as const) {
          child[stream]?.on("data", (chunk: Buffer) => {
            const remaining = 48 * 1024 - output[stream].length;
            if (chunk.length > remaining) truncated[stream] = true;
            output[stream] = Buffer.concat([output[stream], chunk.subarray(0, remaining)]);
          });
        }
        child.once("error", () => {
          children.delete(child);
          resolve(
            actionError(
              "exec_failed",
              "Could not start the program. Check the executable and working directory.",
            ),
          );
        });
        child.once("close", (exitCode, signal) => {
          children.delete(child);
          const redact = (value: Buffer) =>
            secrets.reduce(
              (text, secret) => text.replaceAll(secret, "[redacted]"),
              value.toString("utf8"),
            );
          resolve({
            type: "response",
            ok: true,
            result: {
              exitCode,
              signal,
              stdout: redact(output.stdout),
              stderr: redact(output.stderr),
              truncated,
            },
          });
        });
      });
    },
  };
  return {
    async receive(message: InboundEnvelope) {
      const request = message.payload;
      if (!isRecord(request) || request.type !== "request" || typeof request.action !== "string")
        return;
      const current = generation;
      const handler = Object.hasOwn(handlers, request.action)
        ? handlers[request.action]
        : undefined;
      const payload = handler
        ? await handler(request.args).catch(() => actionError("exec_failed", "The action failed."))
        : actionError("unsupported_action", "The computer does not support this action.");
      const reply = { id: message.id, to: message.from, payload };
      if (payload.ok && isRecord(payload.result) && isRecord(payload.result.truncated)) {
        const result = payload.result;
        while (byteLength(JSON.stringify(reply)) > MAX_MESSAGE_BYTES) {
          for (const stream of ["stdout", "stderr"] as const) {
            if (typeof result[stream] === "string" && result[stream].length > 0) {
              result[stream] = result[stream].slice(0, Math.floor(result[stream].length * 0.75));
              (result.truncated as Record<string, boolean>)[stream] = true;
            }
          }
        }
      }
      // A process from an earlier connection must never reply on its replacement.
      if (current === generation) send(reply);
    },
    disconnect() {
      generation++;
      for (const child of children) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1000);
        timer.unref();
      }
    },
  };
}
