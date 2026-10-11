// File transfers over binary frames. Protocol: docs/rome-node.md#file-transfer-protocol.
// The caller daemon and the host share these endpoints, so both sides use Node fs streams
// and the same windowing, checksum, and cleanup rules.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Stream } from "node:stream";
import { actionError, isRecord, parseResponse, type ActionResponse } from "./actions.js";
import type { CopyProgress, CopyRequest } from "./daemon-protocol.js";
import { FRAME_HEADER_BYTES, MAX_FRAME_BYTES } from "./frame.js";

export const TRANSFER_VERSION = 1;
export const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;
export const TRANSFER_WINDOW_BYTES = 16 * 1024 * 1024;
export const TRANSFER_IDLE_MS = 60_000;
export const MAX_HOST_TRANSFERS = 4;
export const PART_SUFFIX = ".rome-part";

/** Meta of every transfer frame after transfer.open and its reply. Data bytes travel in the body. */
export type TransferMessage =
  | { type: "transfer"; kind: "data"; offset: number }
  | { type: "transfer"; kind: "ack"; offset: number }
  | { type: "transfer"; kind: "end"; size: number; sha256: string }
  | { type: "transfer"; kind: "done"; size: number; sha256: string }
  | { type: "transfer"; kind: "abort"; code: string; message: string };

const isSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Returns null for anything that is not a transfer message. */
export function parseTransferMessage(value: unknown): TransferMessage | null {
  if (!isRecord(value) || value.type !== "transfer") return null;
  switch (value.kind) {
    case "data":
    case "ack":
      return isSize(value.offset)
        ? { type: "transfer", kind: value.kind, offset: value.offset }
        : null;
    case "end":
    case "done":
      return isSize(value.size) && isDigest(value.sha256)
        ? { type: "transfer", kind: value.kind, size: value.size, sha256: value.sha256 }
        : null;
    case "abort":
      return typeof value.code === "string" && typeof value.message === "string"
        ? { type: "transfer", kind: "abort", code: value.code, message: value.message }
        : null;
    default:
      return null;
  }
}

export class TransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fsError(error: unknown): TransferError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new TransferError(
    code === "ENOENT"
      ? "not_found"
      : code === "EACCES" || code === "EPERM"
        ? "permission_denied"
        : code === "EISDIR"
          ? "is_directory"
          : "io_error",
    error instanceof Error ? error.message : "The file operation failed.",
  );
}

/** Sends one frame meta, and optional body bytes, to the peer. False means it was not submitted. */
export type TransferSend = (meta: unknown, body?: Uint8Array) => boolean;

export interface TransferOptions {
  chunkBytes?: number;
  /** Most bytes sent and not yet acknowledged. Must be at least chunkBytes. */
  windowBytes?: number;
  /** A transfer with no message sent or received for this long aborts with `timeout`. */
  idleMs?: number;
  /** Bytes the receiver has handed to the OS. */
  onProgress?(bytes: number): void;
}

export interface TransferSummary {
  size: number;
  sha256: string;
}

/** One side of one transfer. Feed it the peer's transfer messages for this transfer only. */
export interface TransferEndpoint {
  /** Resolves after verification, or rejects with TransferError once cleanup has finished. */
  readonly result: Promise<TransferSummary>;
  receive(message: TransferMessage, body: Uint8Array): void;
  /** Stops the transfer and deletes a partial destination. Tells the peer unless notify is false. */
  abort(code: string, message: string, notify?: boolean): void;
}

export interface ReceiverEndpoint extends TransferEndpoint {
  /** Sets the size announced by the sender. The receiver rejects any other size. */
  expect(size: number): void;
}

const closed = (stream: Stream & { closed: boolean; destroy(): void }) =>
  stream.closed
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        stream.once("close", () => resolve());
        stream.destroy();
      });

function lifecycle(send: TransferSend, idleMs: number, cleanup: () => Promise<void>) {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (summary: TransferSummary) => void;
  let reject!: (error: TransferError) => void;
  const result = new Promise<TransferSummary>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  result.catch(() => {});
  const abort = (code: string, message: string, notify = true) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (notify) send({ type: "transfer", kind: "abort", code, message });
    void cleanup()
      .catch(() => {})
      .finally(() => reject(new TransferError(code, message)));
  };
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => abort("timeout", `No transfer progress for ${idleMs / 1000} seconds.`),
      idleMs,
    );
    timer.unref();
  };
  return {
    result,
    abort,
    touch,
    finish(summary: TransferSummary) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(summary);
    },
    get settled() {
      return settled;
    },
  };
}

export interface Source {
  size: number;
  /** Starts sending data frames. Call at most once. */
  start(send: TransferSend, options?: TransferOptions): TransferEndpoint;
  /** Releases the file when start was never called. */
  close(): Promise<void>;
}

const notAFile = (path: string) =>
  new TransferError("not_a_file", `${path} is not a regular file.`);

/** Opens a regular file for sending. Refuses FIFOs, devices, and directories. Throws TransferError. */
export async function openSource(path: string): Promise<Source> {
  // Opening a FIFO for reading blocks inside a libuv worker, where no timeout or abort reaches it.
  const info = await stat(path).catch((error) => {
    throw fsError(error);
  });
  if (!info.isFile()) throw notAFile(path);
  let handle: FileHandle;
  try {
    // O_NONBLOCK keeps open() from waiting if the path became a FIFO after the stat above.
    // Reads from a regular file ignore it. Windows defines no O_NONBLOCK.
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    throw fsError(error);
  }
  let size: number;
  try {
    // The descriptor, not the path, decides what is read.
    const opened = await handle.stat();
    if (!opened.isFile()) throw notAFile(path);
    size = opened.size;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error instanceof TransferError ? error : fsError(error);
  }
  let started = false;
  return {
    size,
    start(send, options) {
      started = true;
      return startSender(handle, send, options);
    },
    async close() {
      if (!started) await handle.close().catch(() => {});
    },
  };
}

function startSender(
  handle: FileHandle,
  send: TransferSend,
  options: TransferOptions = {},
): TransferEndpoint {
  const chunkBytes = options.chunkBytes ?? TRANSFER_CHUNK_BYTES;
  const windowBytes = options.windowBytes ?? TRANSFER_WINDOW_BYTES;
  if (windowBytes < chunkBytes) throw new RangeError("The window must hold at least one chunk.");
  // Data meta stays far below 1 KiB, so this keeps every data frame within MAX_FRAME_BYTES.
  if (chunkBytes > MAX_FRAME_BYTES - FRAME_HEADER_BYTES - 1024)
    throw new RangeError("A chunk must fit in one frame.");
  const stream = handle.createReadStream({ highWaterMark: chunkBytes });
  const hash = createHash("sha256");
  let sent = 0;
  let acked = 0;
  let sha256: string | undefined;
  const life = lifecycle(send, options.idleMs ?? TRANSFER_IDLE_MS, () => closed(stream));
  // Pausing before the next chunk could overflow keeps unacknowledged bytes within the window.
  const full = () => sent - acked + chunkBytes > windowBytes;
  const lost = () =>
    life.abort("connection_lost", "The device connection was lost. Run the copy again.", false);
  stream.on("data", (chunk) => {
    if (life.settled) return;
    const bytes = chunk as Buffer;
    hash.update(bytes);
    if (!send({ type: "transfer", kind: "data", offset: sent }, bytes)) return lost();
    sent += bytes.byteLength;
    life.touch();
    if (full()) stream.pause();
  });
  stream.once("end", () => {
    if (life.settled) return;
    sha256 = hash.digest("hex");
    if (!send({ type: "transfer", kind: "end", size: sent, sha256 })) return lost();
    life.touch();
  });
  stream.once("error", (error) => life.abort("read_failed", error.message));
  life.touch();
  return {
    result: life.result,
    abort: life.abort,
    receive(message) {
      if (life.settled) return;
      if (message.kind === "ack") {
        if (message.offset <= acked || message.offset > sent) return;
        acked = message.offset;
        life.touch();
        options.onProgress?.(acked);
        if (stream.isPaused() && !full()) stream.resume();
      } else if (message.kind === "done") {
        if (sha256 === undefined || message.size !== sent || message.sha256 !== sha256)
          life.abort("checksum_mismatch", "The receiver reported a different size or checksum.");
        else life.finish({ size: sent, sha256 });
      } else if (message.kind === "abort") life.abort(message.code, message.message, false);
    },
  };
}

export interface Destination {
  /** Path of the part file this transfer owns. */
  part: string;
  /** Starts accepting data frames into the part file. Call at most once. */
  start(send: TransferSend, options?: TransferOptions & { size?: number }): ReceiverEndpoint;
  /** Deletes the part file when start was never called. */
  cancel(): Promise<void>;
}

/**
 * Creates `<dir>/.<name>.<id>.rome-part` next to `path` with mode 0600. The exclusive create
 * fails on any existing file or symlink, so a transfer never writes through a name it does not own.
 */
export async function createPartFile(
  path: string,
  id: string = randomUUID(),
): Promise<{ part: string; handle: FileHandle }> {
  // Keeps the name within the 255-byte file name limit of common filesystems.
  const name = Buffer.from(basename(path)).subarray(0, 160).toString("utf8");
  const part = join(dirname(path), `.${name}.${id}${PART_SUFFIX}`);
  try {
    return { part, handle: await open(part, "wx", 0o600) };
  } catch (error) {
    throw fsError(error);
  }
}

/** Creates this transfer's own part file. Refuses a directory at path. Throws TransferError. */
export async function openDestination(path: string): Promise<Destination> {
  const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw fsError(error);
  });
  if (existing?.isDirectory()) throw new TransferError("is_directory", `${path} is a directory.`);
  const { part, handle } = await createPartFile(path);
  let started = false;
  return {
    part,
    start(send, options) {
      started = true;
      return startReceiver(handle, path, part, send, options);
    },
    async cancel() {
      if (started) return;
      await handle.close().catch(() => {});
      await rm(part, { force: true });
    },
  };
}

/**
 * Mode for a finished copy: the replaced file's permission bits, or what a new file in that
 * directory gets. Setuid, setgid, and sticky bits are not carried over to the new content.
 */
async function finalMode(path: string): Promise<number> {
  const current = await stat(path).catch(() => null);
  if (current) return current.mode & 0o777;
  // A probe file created with the default mode shows the umask and any default ACL. Reading
  // the umask through process.umask() is deprecated because it briefly changes it.
  const probe = join(dirname(path), `.${randomUUID()}.rome-mode`);
  const handle = await open(probe, "wx");
  try {
    return (await handle.stat()).mode & 0o777;
  } finally {
    await handle.close();
    await rm(probe, { force: true });
  }
}

function startReceiver(
  handle: FileHandle,
  path: string,
  part: string,
  send: TransferSend,
  options: TransferOptions & { size?: number } = {},
): ReceiverEndpoint {
  // flush makes the stream fsync the part file before it closes the handle.
  const stream = handle.createWriteStream({ flush: true });
  const hash = createHash("sha256");
  let expected = options.size;
  let received = 0;
  let written = 0;
  let ending = false;
  const life = lifecycle(send, options.idleMs ?? TRANSFER_IDLE_MS, async () => {
    await closed(stream);
    // Only this transfer's own part file is removed.
    await rm(part, { force: true });
  });
  stream.on("error", (error) => life.abort("write_failed", error.message));
  async function finish(size: number, sha256: string) {
    const actual = hash.digest("hex");
    // fchmod works on the open descriptor. The handle closes when the stream does.
    if (process.platform !== "win32") await handle.chmod(await finalMode(path));
    if (life.settled) return;
    // done promises the data survives a crash, so the flush and close finish before the rename.
    await new Promise<void>((resolve, reject) => {
      stream.once("close", resolve);
      stream.once("error", reject);
      stream.end();
    });
    if (life.settled) return;
    if (received !== size || (expected !== undefined && expected !== size))
      return life.abort(
        "size_mismatch",
        `Received ${received} bytes, expected ${expected ?? size}. ${path} was not changed.`,
      );
    if (actual !== sha256)
      return life.abort(
        "checksum_mismatch",
        `The SHA-256 checksum does not match. ${path} was not changed.`,
      );
    try {
      await rename(part, path);
    } catch (error) {
      const failure = fsError(error);
      return life.abort(failure.code, failure.message);
    }
    send({ type: "transfer", kind: "done", size, sha256 });
    life.finish({ size, sha256 });
  }
  life.touch();
  return {
    result: life.result,
    abort: life.abort,
    expect(size) {
      expected = size;
    },
    receive(message, body) {
      if (life.settled) return;
      if (message.kind === "data") {
        if (ending || message.offset !== received)
          return life.abort("out_of_order", "Transfer data arrived out of order.");
        const length = body.byteLength;
        if (expected !== undefined && received + length > expected)
          return life.abort("size_mismatch", `Received more than ${expected} bytes.`);
        received += length;
        hash.update(body);
        life.touch();
        // Acknowledge only after the OS has the bytes, so the window bounds buffered memory.
        stream.write(body, (error) => {
          if (error || life.settled) return;
          written += length;
          options.onProgress?.(written);
          if (!send({ type: "transfer", kind: "ack", offset: written }))
            life.abort(
              "connection_lost",
              "The device connection was lost. Run the copy again.",
              false,
            );
        });
      } else if (message.kind === "end") {
        if (ending) return;
        ending = true;
        life.touch();
        finish(message.size, message.sha256).catch((error) =>
          life.abort("write_failed", error instanceof Error ? error.message : "Write failed."),
        );
      } else if (message.kind === "abort") life.abort(message.code, message.message, false);
    },
  };
}

interface OpenArgs {
  direction: "push" | "pull";
  path: string;
  size?: number;
}

function parseOpen(args: unknown): OpenArgs | null {
  if (
    !isRecord(args) ||
    (args.direction !== "push" && args.direction !== "pull") ||
    typeof args.path !== "string" ||
    !args.path ||
    args.path.includes("\0") ||
    (args.direction === "push" && !isSize(args.size))
  )
    return null;
  return {
    direction: args.direction,
    path: args.path,
    ...(args.direction === "push" ? { size: args.size as number } : {}),
  };
}

interface HostTransfer {
  peer: string;
  endpoint?: TransferEndpoint;
  canceled: boolean;
}

/** Device side of transfers. Isolates concurrent transfers by transfer ID and sender. */
export class TransferHost {
  private transfers = new Map<string, HostTransfer>();

  constructor(private options: TransferOptions & { limit?: number } = {}) {}

  /**
   * Handles transfer.open and runs the transfer to completion. `send` must drop frames once the
   * connection that carried the request is replaced. A repeated ID is ignored.
   */
  async open(id: string, peer: string, args: unknown, send: TransferSend): Promise<void> {
    if (this.transfers.has(id)) return;
    const request = parseOpen(args);
    if (!request) {
      send(
        actionError(
          "invalid_args",
          "transfer.open requires direction push or pull, a path, and a size for push.",
        ),
      );
      return;
    }
    if (this.transfers.size >= (this.options.limit ?? MAX_HOST_TRANSFERS)) {
      send(actionError("busy", "The computer is already running its maximum number of transfers."));
      return;
    }
    const entry: HostTransfer = { peer, canceled: false };
    this.transfers.set(id, entry);
    try {
      if (request.direction === "push") {
        const destination = await openDestination(request.path);
        if (entry.canceled) return void (await destination.cancel());
        entry.endpoint = destination.start(send, { ...this.options, size: request.size });
        send({ type: "response", ok: true, result: {} } satisfies ActionResponse);
      } else {
        const source = await openSource(request.path);
        if (entry.canceled) return void (await source.close());
        send({
          type: "response",
          ok: true,
          result: { size: source.size },
        } satisfies ActionResponse);
        entry.endpoint = source.start(send, this.options);
      }
      await entry.endpoint.result.catch(() => {});
    } catch (error) {
      if (!entry.canceled)
        send(
          error instanceof TransferError
            ? actionError(error.code, error.message)
            : actionError("io_error", "The transfer failed."),
        );
    } finally {
      this.transfers.delete(id);
    }
  }

  /** Routes a transfer message. Messages for unknown IDs or from another sender are ignored. */
  receive(id: string, peer: string, message: TransferMessage, body: Uint8Array) {
    const entry = this.transfers.get(id);
    if (!entry || entry.peer !== peer) return;
    if (entry.endpoint) entry.endpoint.receive(message, body);
    else if (message.kind === "abort") entry.canceled = true;
  }

  /** Aborts every transfer without notifying peers, for example after the connection is lost. */
  abortAll() {
    for (const entry of this.transfers.values()) {
      entry.canceled = true;
      entry.endpoint?.abort("connection_lost", "The host connection was lost.", false);
    }
  }
}

/** Frame channel to one device for one transfer. */
export interface TransferChannel {
  send: TransferSend;
  close(): void;
}

/** Delivers the device's frames for one channel. Route errors arrive as failed ActionResponses. */
export interface ChannelEvents {
  frame(meta: unknown, body: Uint8Array): void;
  lost(): void;
}

export interface CopyOptions extends Omit<TransferOptions, "onProgress"> {
  signal?: AbortSignal;
  onProgress?(progress: CopyProgress): void;
}

/**
 * Caller side of `rome-node cp`. Copies between a local file and a device file and resolves after
 * both sides agree on size and SHA-256. Throws TransferError. A failed copy leaves both
 * destinations unchanged and removes the part files, so it can be run again.
 */
export async function copyWithDevice(
  openChannel: (events: ChannelEvents) => Promise<TransferChannel | ActionResponse>,
  request: CopyRequest,
  options: CopyOptions = {},
): Promise<{ bytes: number; sha256: string; ms: number }> {
  const started = Date.now();
  const { signal, onProgress, ...transfer } = options;
  const canceled = () => new TransferError("canceled", "The copy was canceled.");
  if (signal?.aborted) throw canceled();
  const idleMs = transfer.idleMs ?? TRANSFER_IDLE_MS;
  const source = request.direction === "push" ? await openSource(request.localPath) : undefined;
  let destination: Destination | undefined;
  try {
    if (request.direction === "pull") destination = await openDestination(request.localPath);
    // An abort during the awaits above has no listener yet, so each await is followed by a check.
    if (signal?.aborted) throw canceled();
  } catch (error) {
    await source?.close();
    await destination?.cancel();
    throw error;
  }
  let total = source?.size ?? 0;
  let endpoint: TransferEndpoint | undefined;
  let receiver: ReceiverEndpoint | undefined;
  let channel: TransferChannel | undefined;
  let opened = false;
  let settle!: (value: TransferSummary | TransferError) => void;
  const outcome = new Promise<TransferSummary | TransferError>((resolve) => {
    settle = resolve;
  });
  const attach = (next: TransferEndpoint) => {
    endpoint = next;
    next.result.then(settle, (error) =>
      settle(error instanceof TransferError ? error : new TransferError("io_error", String(error))),
    );
  };
  const fail = (error: TransferError, notify: boolean) => {
    if (endpoint) return endpoint.abort(error.code, error.message, notify);
    if (notify)
      channel?.send({ type: "transfer", kind: "abort", code: error.code, message: error.message });
    void Promise.resolve(source?.close() ?? destination?.cancel()).finally(() => settle(error));
  };
  const progress = (bytes: number) => onProgress?.({ bytes, total });
  // A pull has its receiver before the open reply, so this timer only guards a push.
  const opening = source
    ? setTimeout(
        () => fail(new TransferError("timeout", "The device did not answer the copy."), true),
        idleMs,
      )
    : undefined;
  const result = await openChannel({
    frame(meta, body) {
      const response = parseResponse(meta);
      if (response) {
        if (!response.ok)
          return fail(new TransferError(response.error.code, response.error.message), false);
        if (opened || !channel) return;
        opened = true;
        clearTimeout(opening);
        if (source)
          return attach(source.start(channel.send, { ...transfer, onProgress: progress }));
        const size = isRecord(response.result) ? response.result.size : undefined;
        if (!isSize(size))
          return fail(new TransferError("invalid_response", "The device sent no file size."), true);
        total = size;
        receiver?.expect(size);
        return;
      }
      const message = parseTransferMessage(meta);
      if (message && endpoint) endpoint.receive(message, body);
      else if (message?.kind === "abort")
        fail(new TransferError(message.code, message.message), false);
    },
    lost() {
      fail(
        new TransferError("connection_lost", "The device connection was lost. Run the copy again."),
        false,
      );
    },
  });
  if (!("send" in result)) {
    clearTimeout(opening);
    await (source?.close() ?? destination?.cancel());
    throw result.ok
      ? new TransferError("invalid_response", "The device channel could not be opened.")
      : new TransferError(result.error.code, result.error.message);
  }
  channel = result;
  if (signal?.aborted) {
    clearTimeout(opening);
    channel.close();
    await (source?.close() ?? destination?.cancel());
    throw canceled();
  }
  // No await follows until transfer.open is sent, so an abort after the check above reaches the
  // listener registered below.
  if (destination) {
    receiver = destination.start(channel.send, { ...transfer, onProgress: progress });
    attach(receiver);
  }
  const cancel = () => fail(canceled(), true);
  signal?.addEventListener("abort", cancel, { once: true });
  const args = {
    direction: request.direction,
    path: request.remotePath,
    ...(source ? { size: source.size } : {}),
  };
  if (!channel.send({ type: "request", action: "transfer.open", args }))
    fail(new TransferError("connection_lost", "The copy could not be sent to the device."), false);
  const value = await outcome;
  clearTimeout(opening);
  signal?.removeEventListener("abort", cancel);
  channel.close();
  if (value instanceof TransferError) throw value;
  return { bytes: value.size, sha256: value.sha256, ms: Date.now() - started };
}
