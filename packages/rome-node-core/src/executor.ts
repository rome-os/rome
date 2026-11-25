import { spawn, type ChildProcess } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { actionError, isRecord, type ActionResponse } from "./actions.js";
import { AUDIT_PUSH_BYTES, type AuditOutcome, type AuditStore } from "./audit.js";
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
) {
  const children = new Set<ChildProcess>();
  const transfers = new TransferHost({ keepBytes: AUDIT_PUSH_BYTES });
  let generation = 0;
  const info = async (): Promise<ActionResponse> => ({
    type: "response",
    ok: true,
    result: {
      name,
      platform: platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : platform(),
      // Lists caller-facing actions only. transfer.open is an internal frame protocol for
      // rome-node cp, so it is omitted on purpose. Callers detect it through transferVersion.
      actions: ["system.info", "exec", "fs.list"],
      frameVersion: 1,
      transferVersion: TRANSFER_VERSION,
      // Unavailable means every other action is refused until the owner fixes the log.
      audit: await audit.status(),
    },
  });
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

  const handlers: Record<string, (args: unknown, notes: Notes) => Promise<ActionResponse>> = {
    "system.info": () => info(),
    exec: async (input, notes) => {
      const parsed = execInput(input);
      if (!parsed) return invalidExec();
      const output = await runProgram(parsed, notes);
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
    "fs.list": listFolder,
  };
  const empty = new Uint8Array();
  // Binary mode: the request body is the program's stdin and stdout is the response body.
  const frameHandlers: Record<
    string,
    (
      args: unknown,
      body: Uint8Array,
      notes: Notes,
    ) => Promise<{ response: ActionResponse; body: Uint8Array }>
  > = {
    "system.info": async () => ({ response: await info(), body: empty }),
    "fs.list": async (input) => ({ response: await listFolder(input), body: empty }),
    exec: async (input, body, notes) => {
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
            stderr: redactText(output.stderr),
            truncated: { stdout: false, stderr: false },
          },
        },
        body: redactBytes(output.stdout, secrets),
      };
    },
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
    const current = generation;
    const action = request.action;
    const handler = Object.hasOwn(handlers, action) ? handlers[action] : undefined;
    const notes: Notes = { fields: {}, content: {} };
    // system.info changes nothing and is probed on every dashboard refresh, so it is not
    // recorded. Every other request is recorded before it runs, or refused.
    const started = Date.now();
    const seq =
      action === "system.info"
        ? 0
        : await audit.start(
            action,
            startRecord(action, request.args, {
              requestId: message.id,
              from: message.from,
              transport: "json",
              generation: current,
            }),
            {},
            secrets,
          );
    const payload =
      seq === null
        ? refused()
        : current !== generation
          ? replaced()
          : handler
            ? await handler(request.args, notes).catch(() =>
                actionError("exec_failed", "The action failed."),
              )
            : actionError("unsupported_action", "The computer does not support this action.");
    const reply = { id: message.id, to: message.from, payload };
    // A process from an earlier connection must never reply on its replacement.
    const interrupted = current !== generation;
    if (seq)
      endRecord(
        action,
        seq,
        started,
        payload,
        interrupted,
        notes,
        interrupted ? 0 : Buffer.byteLength(JSON.stringify(reply)),
      );
    if (!interrupted) send(reply);
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
    const current = generation;
    const action = request.action;
    const respond = (response: ActionResponse) =>
      current === generation &&
      sendFrame({
        type: FRAME_TYPE.response,
        id: frame.id,
        peer: frame.peer,
        meta: encodeMeta(response),
        body: empty,
      });
    const started = Date.now();
    const seq =
      action === "system.info"
        ? 0
        : await audit.start(
            action,
            startRecord(action, request.args, {
              requestId: frame.id,
              from: frame.peer,
              transport: "binary",
              generation: current,
            }),
            { stdin: frame.body },
            secrets,
          );
    if (seq === null) {
      // For a push this also means no part file is created.
      respond(refused());
      return;
    }
    if (current !== generation) {
      endRecord(action, seq, started, replaced(), true, { fields: {}, content: {} }, 0);
      return;
    }
    if (action === "transfer.open") {
      // The transfer outlives this frame. Later frames for it arrive through transfers.receive.
      const transfer = transfers.open(frame.id, frame.peer, request.args, (meta, body = empty) => {
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
    const handler = Object.hasOwn(frameHandlers, action) ? frameHandlers[action] : undefined;
    const notes: Notes = { fields: {}, content: {} };
    const result = handler
      ? await handler(request.args, frame.body, notes).catch(() => ({
          response: actionError("exec_failed", "The action failed."),
          body: empty,
        }))
      : {
          response: actionError("unsupported_action", "The computer does not support this action."),
          body: empty,
        };
    // A process from an earlier connection must never reply on its replacement.
    const interrupted = current !== generation;
    let response = result.response;
    let meta = encodeMeta(response);
    let body = result.body;
    // An oversized frame would close this connection and with it every program and transfer.
    if (!frameFits(meta.byteLength, body.byteLength)) {
      response = actionError(
        "output_too_large",
        `The output does not fit in one ${MAX_FRAME_BYTES / 1024 / 1024} MiB frame and was discarded. The program ran. Use rome-node cp to copy large files.`,
      );
      meta = encodeMeta(response);
      body = empty;
    }
    if (seq)
      endRecord(
        action,
        seq,
        started,
        response,
        interrupted,
        notes,
        meta.byteLength + body.byteLength,
      );
    if (interrupted) return;
    sendFrame({ type: FRAME_TYPE.response, id: frame.id, peer: frame.peer, meta, body });
  }
  function disconnect() {
    generation++;
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
