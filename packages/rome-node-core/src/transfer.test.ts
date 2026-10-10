import { afterEach, describe, expect, it } from "@rstest/core";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./actions.js";
import {
  copyWithDevice,
  openDestination,
  openSource,
  parseTransferMessage,
  TransferHost,
  type ChannelEvents,
  type TransferEndpoint,
  type TransferSend,
} from "./transfer.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});

const empty = new Uint8Array();
const chunkBytes = 64 * 1024;
const windowBytes = 256 * 1024;
const caller = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "rome-node-transfer-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * Connects a sender and a receiver with asynchronous, ordered delivery. `filter` can drop or
 * rewrite a message. Tracks the largest number of sent and unacknowledged bytes.
 */
function pipe(
  filter: (from: "sender" | "receiver", meta: unknown, body: Uint8Array) => Uint8Array | null = (
    _from,
    _meta,
    body,
  ) => body,
) {
  const ends: { sender?: TransferEndpoint; receiver?: TransferEndpoint } = {};
  let sent = 0;
  let acked = 0;
  let maxUnacked = 0;
  const link =
    (from: "sender" | "receiver", to: "sender" | "receiver"): TransferSend =>
    (meta, body = empty) => {
      const message = parseTransferMessage(meta);
      if (!message) throw new Error("Unexpected meta");
      if (message.kind === "data") {
        sent = message.offset + body.byteLength;
        maxUnacked = Math.max(maxUnacked, sent - acked);
      }
      const delivered = filter(from, meta, body);
      if (delivered && message.kind === "ack") acked = message.offset;
      if (delivered) setImmediate(() => ends[to]?.receive(message, delivered));
      return true;
    };
  return {
    ends,
    toReceiver: link("sender", "receiver"),
    toSender: link("receiver", "sender"),
    maxUnacked: () => maxUnacked,
  };
}

async function copyThrough(source: string, target: string, p = pipe(), idleMs?: number) {
  const from = await openSource(source);
  const to = await openDestination(target);
  p.ends.receiver = to.start(p.toSender, { chunkBytes, windowBytes, idleMs, size: from.size });
  p.ends.sender = from.start(p.toReceiver, { chunkBytes, windowBytes, idleMs });
  const [sent, received] = await Promise.allSettled([p.ends.sender.result, p.ends.receiver.result]);
  return { sent, received, pipe: p };
}

describe("file transfer endpoints", () => {
  it("copies an odd-sized file byte for byte within the window and replaces the destination", async () => {
    const dir = await tempDir();
    const data = randomBytes(1024 * 1024 + 12_345);
    await writeFile(join(dir, "source.bin"), data);
    await writeFile(join(dir, "copy.bin"), "old content");
    const {
      sent,
      received,
      pipe: p,
    } = await copyThrough(join(dir, "source.bin"), join(dir, "copy.bin"));
    const summary = { size: data.byteLength, sha256: sha(data) };
    expect(sent).toEqual({ status: "fulfilled", value: summary });
    expect(received).toEqual({ status: "fulfilled", value: summary });
    expect((await readFile(join(dir, "copy.bin"))).equals(data)).toBe(true);
    expect(await readdir(dir)).toEqual(["copy.bin", "source.bin"]);
    expect(p.maxUnacked()).toBeLessThanOrEqual(windowBytes);
  });

  it("copies an empty file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "empty"), "");
    const { sent, received } = await copyThrough(join(dir, "empty"), join(dir, "copy"));
    expect(sent.status).toBe("fulfilled");
    expect(received.status).toBe("fulfilled");
    expect((await readFile(join(dir, "copy"))).byteLength).toBe(0);
  });

  it("rejects a checksum mismatch and leaves neither destination nor part file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "source.bin"), randomBytes(300_000));
    let tampered = false;
    const p = pipe((from, meta, body) => {
      if (from !== "sender" || tampered || parseTransferMessage(meta)?.kind !== "data") return body;
      tampered = true;
      const copy = Buffer.from(body);
      copy[7] ^= 0xff;
      return copy;
    });
    const { sent, received } = await copyThrough(join(dir, "source.bin"), join(dir, "copy"), p);
    expect(received).toMatchObject({ status: "rejected", reason: { code: "checksum_mismatch" } });
    expect(sent).toMatchObject({ status: "rejected", reason: { code: "checksum_mismatch" } });
    expect(await readdir(dir)).toEqual(["source.bin"]);
  });

  it("cleans up the part file when the sender aborts midway", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "source.bin"), randomBytes(2 * 1024 * 1024));
    await writeFile(join(dir, "copy"), "keep");
    let aborted = false;
    const p = pipe((from, meta, body) => {
      if (from === "receiver" && !aborted && parseTransferMessage(meta)?.kind === "ack") {
        aborted = true;
        setImmediate(() => p.ends.sender?.abort("canceled", "The copy was canceled."));
      }
      return body;
    });
    const { sent, received } = await copyThrough(join(dir, "source.bin"), join(dir, "copy"), p);
    expect(sent).toMatchObject({ status: "rejected", reason: { code: "canceled" } });
    expect(received).toMatchObject({ status: "rejected", reason: { code: "canceled" } });
    expect(await readdir(dir)).toEqual(["copy", "source.bin"]);
    expect(await readFile(join(dir, "copy"), "utf8")).toBe("keep");
  });

  it("aborts both sides after the idle limit when acknowledgements stop", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "source.bin"), randomBytes(1024 * 1024));
    const p = pipe((from, meta, body) =>
      from === "receiver" && parseTransferMessage(meta)?.kind === "ack" ? null : body,
    );
    const { sent, received } = await copyThrough(
      join(dir, "source.bin"),
      join(dir, "copy"),
      p,
      100,
    );
    expect(sent).toMatchObject({ status: "rejected", reason: { code: "timeout" } });
    expect(received).toMatchObject({ status: "rejected", reason: { code: "timeout" } });
    // Without acknowledgements the sender fills exactly one window and then waits.
    expect(p.maxUnacked()).toBe(windowBytes);
    expect(await readdir(dir)).toEqual(["source.bin"]);
  });

  it("refuses directories and missing sources", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "folder"));
    await expect(openDestination(join(dir, "folder"))).rejects.toMatchObject({
      code: "is_directory",
    });
    await expect(openSource(join(dir, "folder"))).rejects.toMatchObject({
      code: expect.stringMatching(/^(not_a_file|is_directory|permission_denied)$/),
    });
    await expect(openSource(join(dir, "missing"))).rejects.toMatchObject({ code: "not_found" });
    expect(await readdir(dir)).toEqual(["folder"]);
  });
});

/** Opens channels to an in-process TransferHost with asynchronous, ordered delivery. */
function hostChannels(host: TransferHost) {
  return async (events: ChannelEvents) => {
    const id = randomUUID();
    const toCaller: TransferSend = (meta, body = empty) => {
      const copy = JSON.parse(JSON.stringify(meta));
      setImmediate(() => events.frame(copy, body));
      return true;
    };
    return {
      send: (meta: unknown, body: Uint8Array = empty) => {
        setImmediate(() => {
          const message = parseTransferMessage(meta);
          if (message) host.receive(id, caller, message, body);
          else if (isRecord(meta) && meta.action === "transfer.open")
            void host.open(id, caller, meta.args, toCaller);
        });
        return true;
      },
      close() {},
    };
  };
}

describe("copies between the caller and a transfer host", () => {
  it("pushes and pulls through the host with progress", async () => {
    const dir = await tempDir();
    const data = randomBytes(700_001);
    await writeFile(join(dir, "local.bin"), data);
    const host = new TransferHost({ chunkBytes, windowBytes });
    const progress: number[] = [];
    const pushed = await copyWithDevice(
      hostChannels(host),
      {
        direction: "push",
        localPath: join(dir, "local.bin"),
        deviceId: caller,
        remotePath: join(dir, "remote.bin"),
      },
      { chunkBytes, windowBytes, onProgress: ({ bytes, total }) => progress.push(bytes / total) },
    );
    expect(pushed).toMatchObject({ bytes: data.byteLength, sha256: sha(data) });
    expect((await readFile(join(dir, "remote.bin"))).equals(data)).toBe(true);
    expect(progress.at(-1)).toBe(1);
    const pulled = await copyWithDevice(hostChannels(host), {
      direction: "pull",
      localPath: join(dir, "back.bin"),
      deviceId: caller,
      remotePath: join(dir, "remote.bin"),
    });
    expect(pulled.sha256).toBe(sha(data));
    expect((await readFile(join(dir, "back.bin"))).equals(data)).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(["back.bin", "local.bin", "remote.bin"]);
  });

  it("reports remote errors without leaving local part files", async () => {
    const dir = await tempDir();
    const host = new TransferHost();
    await expect(
      copyWithDevice(hostChannels(host), {
        direction: "pull",
        localPath: join(dir, "back.bin"),
        deviceId: caller,
        remotePath: join(dir, "missing.bin"),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await mkdir(join(dir, "folder"));
    await writeFile(join(dir, "local.bin"), "x");
    await expect(
      copyWithDevice(hostChannels(host), {
        direction: "push",
        localPath: join(dir, "local.bin"),
        deviceId: caller,
        remotePath: join(dir, "folder"),
      }),
    ).rejects.toMatchObject({ code: "is_directory" });
    expect((await readdir(dir)).sort()).toEqual(["folder", "local.bin"]);
  });

  it("limits concurrent host transfers, isolates senders, and aborts all on disconnect", async () => {
    const dir = await tempDir();
    const host = new TransferHost({ limit: 2 });
    const replies: unknown[][] = [[], [], []];
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const opens = ids.map((id, n) =>
      host.open(id, caller, { direction: "push", path: join(dir, `f${n}`), size: 10 }, (meta) => {
        replies[n].push(meta);
        return true;
      }),
    );
    await opens[2];
    expect(replies[2]).toMatchObject([{ ok: false, error: { code: "busy" } }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replies[0]).toMatchObject([{ ok: true }]);
    expect((await readdir(dir)).sort()).toEqual(["f0.rome-part", "f1.rome-part"]);
    host.receive(
      ids[0],
      randomUUID(),
      { type: "transfer", kind: "abort", code: "x", message: "x" },
      empty,
    );
    expect((await readdir(dir)).sort()).toEqual(["f0.rome-part", "f1.rome-part"]);
    host.abortAll();
    await Promise.all(opens);
    expect(await readdir(dir)).toEqual([]);
    expect(replies[0]).toHaveLength(1);
  });
});
