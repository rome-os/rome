import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { actionError, isRecord, type ActionResponse } from "./actions.js";
import {
  decodeMeta,
  encodeMeta,
  FRAME_TYPE,
  frameFits,
  MAX_FRAME_BYTES,
  type Frame,
} from "./frame.js";
import type { InboundEnvelope, OutboundEnvelope } from "./protocol.js";
import { parseTransferMessage, TRANSFER_VERSION, TransferHost } from "./transfer.js";

interface ExecInput {
  command: string;
  args: string[];
  cwd?: string;
}
interface ProgramOutput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

function execInput(input: unknown): ExecInput | null {
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
    return null;
  return {
    command: input.command,
    args: (input.args ?? []) as string[],
    cwd: input.cwd as string | undefined,
  };
}

/** Overwrites each secret occurrence with as many `*` bytes, so byte offsets stay valid. */
export function redactBytes(data: Buffer, secrets: string[]): Buffer {
  for (const secret of secrets) {
    const needle = Buffer.from(secret);
    if (!needle.byteLength) continue;
    for (let at = data.indexOf(needle); at !== -1; at = data.indexOf(needle, at + needle.length))
      data.fill(0x2a, at, at + needle.byteLength);
  }
  return data;
}

export function createExecutor(
  name: string,
  send: (message: OutboundEnvelope) => boolean,
  secrets: string[] = [],
  sendFrame: (frame: Frame) => boolean = () => false,
) {
  const children = new Set<ChildProcess>();
  const transfers = new TransferHost();
  let generation = 0;
  const info = (): ActionResponse => ({
    type: "response",
    ok: true,
    result: {
      name,
      platform: platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : platform(),
      // Lists caller-facing actions only. transfer.open is an internal frame protocol for
      // rome-node cp, so it is omitted on purpose. Callers detect it through transferVersion.
      actions: ["system.info", "exec"],
      frameVersion: 1,
      transferVersion: TRANSFER_VERSION,
    },
  });
  const invalidExec = () =>
    actionError("invalid_args", "exec requires command, optional string args[], and optional cwd.");

  /** Without stdin, the child gets no stdin. With stdin, the child reads it and then EOF. */
  function runProgram(
    { command, args, cwd }: ExecInput,
    stdin?: Uint8Array,
  ): Promise<ProgramOutput | ActionResponse> {
    if (children.size >= 8)
      return Promise.resolve(
        actionError("busy", "The computer is already running eight programs."),
      );
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
          stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
      } catch {
        resolve(actionError("exec_failed", "Could not start the program."));
        return;
      }
      children.add(child);
      if (stdin && child.stdin) {
        // A child can exit without reading its input. EPIPE is not an action failure.
        child.stdin.on("error", () => {});
        child.stdin.end(stdin);
      }
      const output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
      for (const stream of ["stdout", "stderr"] as const) {
        child[stream]?.on("data", (chunk: Buffer) => {
          output[stream].push(chunk);
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
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(output.stdout),
          stderr: Buffer.concat(output.stderr),
        });
      });
    });
  }
  const redactText = (data: Buffer) =>
    secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), data.toString("utf8"));
  const isOutput = (value: ProgramOutput | ActionResponse): value is ProgramOutput =>
    !("type" in value);

  const handlers: Record<string, (args: unknown) => Promise<ActionResponse>> = {
    "system.info": async () => info(),
    exec: async (input) => {
      const parsed = execInput(input);
      if (!parsed) return invalidExec();
      const output = await runProgram(parsed);
      if (!isOutput(output)) return output;
      return {
        type: "response",
        ok: true,
        result: {
          exitCode: output.exitCode,
          signal: output.signal,
          stdout: redactText(output.stdout),
          stderr: redactText(output.stderr),
          truncated: { stdout: false, stderr: false },
        },
      };
    },
  };
  const empty = new Uint8Array();
  // Binary mode: the request body is the program's stdin and stdout is the response body.
  const frameHandlers: Record<
    string,
    (args: unknown, body: Uint8Array) => Promise<{ response: ActionResponse; body: Uint8Array }>
  > = {
    "system.info": async () => ({ response: info(), body: empty }),
    exec: async (input, body) => {
      const parsed = execInput(input);
      if (!parsed) return { response: invalidExec(), body: empty };
      const output = await runProgram(parsed, body);
      if (!isOutput(output)) return { response: output, body: empty };
      return {
        response: {
          type: "response",
          ok: true,
          result: {
            exitCode: output.exitCode,
            signal: output.signal,
            stderr: redactText(output.stderr),
            truncated: { stdout: false, stderr: false },
          },
        },
        body: redactBytes(output.stdout, secrets),
      };
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
      // A process from an earlier connection must never reply on its replacement.
      if (current === generation) send(reply);
    },
    /** Handles request frames and replies with a response frame to the sender. Ignores other types. */
    async receiveFrame(frame: Frame) {
      if (frame.type !== FRAME_TYPE.request) return;
      const request = decodeMeta(frame.meta);
      const transfer = parseTransferMessage(request);
      if (transfer) {
        transfers.receive(frame.id, frame.peer, transfer, frame.body);
        return;
      }
      if (!isRecord(request) || request.type !== "request" || typeof request.action !== "string")
        return;
      const current = generation;
      if (request.action === "transfer.open") {
        // The transfer outlives this frame. Later frames for it arrive through transfers.receive.
        void transfers.open(frame.id, frame.peer, request.args, (meta, body = empty) => {
          // A transfer from an earlier connection must never send on its replacement.
          if (current !== generation) return false;
          return sendFrame({
            type: FRAME_TYPE.response,
            id: frame.id,
            peer: frame.peer,
            meta: encodeMeta(meta),
            body,
          });
        });
        return;
      }
      const handler = Object.hasOwn(frameHandlers, request.action)
        ? frameHandlers[request.action]
        : undefined;
      const result = handler
        ? await handler(request.args, frame.body).catch(() => ({
            response: actionError("exec_failed", "The action failed."),
            body: empty,
          }))
        : {
            response: actionError(
              "unsupported_action",
              "The computer does not support this action.",
            ),
            body: empty,
          };
      // A process from an earlier connection must never reply on its replacement.
      if (current !== generation) return;
      let meta = encodeMeta(result.response);
      let body = result.body;
      // An oversized frame would close this connection and with it every program and transfer.
      if (!frameFits(meta.byteLength, body.byteLength)) {
        meta = encodeMeta(
          actionError(
            "output_too_large",
            `The output does not fit in one ${MAX_FRAME_BYTES / 1024 / 1024} MiB frame and was discarded. The program ran. Use rome-node cp to copy large files.`,
          ),
        );
        body = empty;
      }
      sendFrame({ type: FRAME_TYPE.response, id: frame.id, peer: frame.peer, meta, body });
    },
    disconnect() {
      generation++;
      transfers.abortAll();
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
