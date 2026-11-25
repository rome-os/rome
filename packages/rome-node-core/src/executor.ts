import { spawn, type ChildProcess } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { actionError, isRecord, type ActionResponse, type BinaryActionResult } from "./actions.js";
import { AUDIT_PUSH_BYTES, type AuditOutcome, type AuditStore } from "./audit.js";
import { computerUseAuditFields } from "./computer-use/audit-fields.js";
import type { ComputerUseOptions } from "./computer-use/discovery.js";
import { ComputerUseHost } from "./computer-use/host.js";
import {
  decodeMeta,
  encodeMeta,
  FRAME_TYPE,
  frameFits,
  isUuid,
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

/** The most entries one fs.list reply carries. */
export const FS_LIST_LIMIT = 1000;

type EntryType = "dir" | "file" | "symlink" | "other";
const typeOrder: Record<EntryType, number> = { dir: 0, symlink: 1, file: 2, other: 3 };

function fsError(error: unknown): ActionResponse {
  const code = isRecord(error) ? error.code : undefined;
  if (code === "ENOENT") return actionError("not_found", "The folder does not exist.");
  if (code === "EACCES" || code === "EPERM")
    return actionError("permission_denied", "The computer's user cannot read this folder.");
  if (code === "ENOTDIR") return actionError("not_a_directory", "The path is not a folder.");
  return actionError("fs_failed", "Could not read the folder.");
}

/** Lists one folder. No path means the home folder; a relative path starts there. */
async function listFolder(input: unknown): Promise<ActionResponse> {
  const raw = input === undefined || input === null ? {} : input;
  if (
    !isRecord(raw) ||
    (raw.path !== undefined &&
      (typeof raw.path !== "string" || !raw.path || raw.path.includes("\0")))
  )
    return actionError("invalid_args", "fs.list takes an optional non-empty string path.");
  let path: string;
  let entries: { name: string; type: EntryType }[];
  try {
    path = await realpath(resolve(homedir(), (raw.path as string | undefined) ?? "."));
    if (!(await stat(path)).isDirectory())
      return actionError("not_a_directory", "The path is not a folder.");
    entries = (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory()
        ? "dir"
        : entry.isFile()
          ? "file"
          : entry.isSymbolicLink()
            ? "symlink"
            : "other",
    }));
  } catch (error) {
    return fsError(error);
  }
  // Folders first, so a large folder still shows its subfolders after the cap.
  entries.sort(
    (a, b) =>
      typeOrder[a.type] - typeOrder[b.type] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const parent = dirname(path);
  return {
    type: "response",
    ok: true,
    result: {
      path,
      parent: parent === path ? null : parent,
      entries: entries.slice(0, FS_LIST_LIMIT),
      truncated: entries.length > FS_LIST_LIMIT,
    },
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

/** The environment a program gets: this process's, without Rome credentials or NODE_OPTIONS. */
function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:ROME_.*(?:TOKEN|SECRET|CREDENTIAL)|NODE_OPTIONS)$/i.test(key),
    ),
  );
}

/** The part of the audit log the executor writes to. */
export type HostAudit = Pick<AuditStore, "start" | "end" | "host" | "status" | "hint">;

/** What a handler learned while it ran, for the request's end record. */
interface Notes {
  fields: Record<string, unknown>;
  content: { stdout?: Uint8Array; stderr?: Uint8Array; file?: Uint8Array };
}

function outcomeOf(response: ActionResponse, interrupted: boolean): AuditOutcome {
  if (interrupted) return "interrupted";
  if (!response.ok) return "error";
  const result = response.result;
  return isRecord(result) &&
    Object.hasOwn(result, "exitCode") &&
    (result.exitCode !== 0 || result.signal !== null)
    ? "exit_nonzero"
    : "ok";
}

export function createExecutor(
  name: string,
  audit: HostAudit,
  send: (message: OutboundEnvelope) => boolean,
  secrets: string[] = [],
  sendFrame: (frame: Frame) => boolean = () => false,
  computerUse?: ComputerUseOptions,
) {
  const computer = new ComputerUseHost(computerUse);
  const children = new Set<ChildProcess>();
  const transfers = new TransferHost({ keepBytes: AUDIT_PUSH_BYTES });
  let generation = 0;
  const info = async (peer: string): Promise<ActionResponse> => {
    const { capability, actions } = await computer.info(peer);
    return {
      type: "response",
      ok: true,
      result: {
        name,
        platform:
          platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : platform(),
        // transfer.open belongs to the transfer protocol, advertised by transferVersion.
        actions: [...Object.keys(handlers), ...actions],
        frameVersion: 1,
        transferVersion: TRANSFER_VERSION,
        capabilities: [capability],
        audit: await audit.status(),
      },
    };
  };
  // A request the log could not record never runs, so its outcome is known: nothing happened.
  const refused = () =>
    actionError(
      "audit_unavailable",
      `This computer could not record the request in its audit log, so it did not run it. ${audit.hint}`,
    );
  // Recording the start takes a turn of the event loop. A connection replaced meanwhile must
  // not get its request run.
  const replaced = () =>
    actionError("connection_replaced", "The connection was replaced before the request ran.");
  const startRecord = (action: string, args: unknown, extra: Record<string, unknown>) => ({
    ...extra,
    args,
    ...(action === "exec" ? { envKeys: Object.keys(childEnvironment()).sort() } : {}),
  });
  function endRecord(
    action: string,
    startSeq: number,
    started: number,
    response: ActionResponse,
    interrupted: boolean,
    notes: Notes,
    replyBytes: number,
  ) {
    const fields: Record<string, unknown> = {
      durationMs: Date.now() - started,
      ...notes.fields,
      ...(response.ok ? {} : { errorCode: response.error.code }),
      replyBytes: interrupted ? 0 : replyBytes,
    };
    if (action === "fs.list" && response.ok && isRecord(response.result)) {
      fields.path = response.result.path;
      fields.entries = response.result.entries;
      fields.truncated = response.result.truncated;
    }
    audit.end(startSeq, action, outcomeOf(response, interrupted), fields, notes.content, secrets);
  }
  const invalidExec = () =>
    actionError("invalid_args", "exec requires command, optional string args[], and optional cwd.");

  /** Without stdin, the child gets no stdin. With stdin, the child reads it and then EOF. */
  function runProgram(
    { command, args, cwd }: ExecInput,
    notes: Notes,
    stdin?: Uint8Array,
  ): Promise<ProgramOutput | ActionResponse> {
    if (children.size >= 8)
      return Promise.resolve(
        actionError("busy", "The computer is already running eight programs."),
      );
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd,
          env: childEnvironment(),
          shell: false,
          windowsHide: true,
          stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
      } catch {
        resolve(actionError("exec_failed", "Could not start the program."));
        return;
      }
      children.add(child);
      notes.fields.pid = child.pid ?? null;
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
        const result = {
          exitCode,
          signal,
          stdout: Buffer.concat(output.stdout),
          stderr: Buffer.concat(output.stderr),
        };
        notes.fields.exitCode = exitCode;
        notes.fields.signal = signal;
        notes.content = { stdout: result.stdout, stderr: result.stderr };
        resolve(result);
      });
    });
  }
  const redactText = (data: Buffer) =>
    secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), data.toString("utf8"));
  const isOutput = (value: ProgramOutput | ActionResponse): value is ProgramOutput =>
    !("type" in value);

  const empty = new Uint8Array();
  const handlers: Record<
    string,
    (args: unknown, notes: Notes, peer: string, body?: Uint8Array) => Promise<BinaryActionResult>
  > = {
    "system.info": async (_args, _notes, peer) => ({ response: await info(peer), body: empty }),
    exec: async (input, notes, _peer, body) => {
      const parsed = execInput(input);
      if (!parsed) return { response: invalidExec(), body: empty };
      const output = await runProgram(parsed, notes, body);
      if (!isOutput(output)) return { response: output, body: empty };
      return {
        response: {
          type: "response",
          ok: true,
          result: {
            exitCode: output.exitCode,
            signal: output.signal,
            ...(body === undefined ? { stdout: redactText(output.stdout) } : {}),
            stderr: redactText(output.stderr),
            truncated: { stdout: false, stderr: false },
          },
        },
        body: body === undefined ? empty : redactBytes(output.stdout, secrets),
      };
    },
    "fs.list": async (args) => ({ response: await listFolder(args), body: empty }),
  };
  // Requests still running, so a host can let them write their end records before it stops.
  let running = 0;
  const drained: (() => void)[] = [];
  async function track(work: () => Promise<void>) {
    running++;
    try {
      await work();
    } finally {
      if (--running === 0) for (const resolve of drained.splice(0)) resolve();
    }
  }
  return {
    receive: (message: InboundEnvelope) => track(() => receive(message)),
    /** Handles request frames and replies with a response frame to the sender. Ignores other types. */
    receiveFrame: (frame: Frame) => track(() => receiveFrame(frame)),
    /** Resolves once every request that has started is recorded as ended. */
    idle: () =>
      running ? new Promise<void>((resolve) => drained.push(resolve)) : Promise.resolve(),
    disconnect,
  };
  async function receive(message: InboundEnvelope) {
    const request = message.payload;
    if (!isRecord(request) || request.type !== "request" || typeof request.action !== "string")
      return;
    await dispatch(request.action, request.args, message.id, message.from);
  }

  async function receiveFrame(frame: Frame) {
    if (frame.type !== FRAME_TYPE.request) return;
    const request = decodeMeta(frame.meta);
    const transfer = parseTransferMessage(request);
    if (transfer) {
      transfers.receive(frame.id, frame.peer, transfer, frame.body);
      return;
    }
    if (!isRecord(request) || request.type !== "request" || typeof request.action !== "string")
      return;
    await dispatch(request.action, request.args, frame.id, frame.peer, frame.body);
  }

  async function dispatch(
    action: string,
    args: unknown,
    id: string,
    peer: string,
    body?: Uint8Array,
  ) {
    const current = generation;
    const started = Date.now();
    const input = computer.prepare(action, peer, args, body);
    const privateAction = action.startsWith("computer.");
    const recordAction = privateAction && !input ? "computer.unsupported" : action;
    const transport = body === undefined ? "json" : "binary";
    const notes: Notes = { fields: {}, content: {} };
    if (privateAction) Object.assign(notes.fields, computerUseAuditFields(action, args));
    const metadata = {
      ...(!privateAction || isUuid(id) ? { requestId: id } : {}),
      ...(!privateAction || isUuid(peer) ? { from: peer } : {}),
      transport,
      generation: current,
    };
    const respond = (response: ActionResponse, output: Uint8Array = empty, meta?: Uint8Array) => {
      if (current !== generation) return;
      if (body === undefined) send({ id, to: peer, payload: response });
      else
        sendFrame({
          type: FRAME_TYPE.response,
          id,
          peer,
          meta: meta ?? encodeMeta(response),
          body: output,
        });
    };
    try {
      const seq =
        action === "system.info"
          ? 0
          : await audit
              .start(
                recordAction,
                privateAction
                  ? { ...metadata, ...notes.fields }
                  : startRecord(action, args, metadata),
                privateAction || body === undefined ? {} : { stdin: body },
                secrets,
              )
              .catch(() => null);
      if (seq === null && !input) {
        respond(refused());
        return;
      }
      if (current !== generation) {
        if (seq) endRecord(recordAction, seq, started, replaced(), true, notes, 0);
        return;
      }
      if (body !== undefined && action === "transfer.open" && seq) {
        // The transfer outlives its opening frame. Later frames go through transfers.receive.
        const transfer = transfers.open(
          id,
          peer,
          args,
          (meta, data) =>
            current === generation &&
            sendFrame({
              type: FRAME_TYPE.response,
              id,
              peer,
              meta: encodeMeta(meta),
              body: data ?? empty,
            }),
        );
        void track(() =>
          transfer.then(({ code, file, ...fields }) => {
            const response: ActionResponse = code
              ? actionError(code, "")
              : { type: "response", ok: true, result: null };
            endRecord(
              action,
              seq,
              started,
              response,
              current !== generation,
              { fields, content: file ? { file } : {} },
              0,
            );
          }),
        );
        return;
      }
      const handler = Object.hasOwn(handlers, action) ? handlers[action] : undefined;
      const result = input
        ? await input.run(seq === null ? refused() : undefined)
        : handler
          ? await handler(args, notes, peer, body).catch(() => ({
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
      let response = result.response;
      let output = result.body;
      let meta = body === undefined ? undefined : encodeMeta(response);
      // An oversized frame would close the connection and stop every program and transfer.
      if (meta && !frameFits(meta.byteLength, output.byteLength)) {
        response = actionError(
          "output_too_large",
          `The output does not fit in one ${MAX_FRAME_BYTES / 1024 / 1024} MiB frame and was discarded. The program ran. Use rome-node cp to copy large files.`,
        );
        meta = encodeMeta(response);
        output = empty;
      }
      if (action === "computer.cancel" && response.ok && isRecord(response.result)) {
        notes.fields.stop = response.result.stop;
        notes.fields.reason = response.result.reason;
      }
      const interrupted = current !== generation;
      if (seq)
        endRecord(
          recordAction,
          seq,
          started,
          response,
          interrupted,
          notes,
          meta
            ? meta.byteLength + output.byteLength
            : Buffer.byteLength(JSON.stringify({ id, to: peer, payload: response })),
        );
      respond(response, output, meta);
    } finally {
      input?.release();
    }
  }
  function disconnect() {
    generation++;
    computer.disconnect();
    transfers.abortAll();
    for (const child of children) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        // A descendant that inherited the pipes would delay `close` past the host's 3 s shutdown
        // bound, and the interrupted end record would be lost.
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 1000);
      timer.unref();
    }
  }
}
