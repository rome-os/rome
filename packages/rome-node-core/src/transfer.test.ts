import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./actions.js";
import { FRAME_HEADER_BYTES, MAX_FRAME_BYTES } from "./frame.js";
import {
  copyWithDevice,
  createPartFile,
  openDestination,
  openSource,
  parseTransferMessage,
  TRANSFER_CHUNK_BYTES,
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
const posix = process.platform !== "win32";
/** Maps `.<name>.<uuid>.rome-part` to `<name>`, and any other file name to itself. */
const partOwner = (file: string) => /^\.(.*)\.[0-9a-f-]{36}\.rome-part$/.exec(file)?.[1] ?? file;
const parts = async (dir: string) =>
  (await readdir(dir)).filter((file) => /\.[0-9a-f-]{36}\.rome-part$/.test(file));

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
function hostChannels(host: TransferHost, actions: string[] = []) {
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
          else if (isRecord(meta) && meta.action === "transfer.open") {
            actions.push(meta.action);
            void host.open(id, caller, meta.args, toCaller);
          }
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
    expect((await readdir(dir)).map(partOwner).sort()).toEqual(["f0", "f1"]);
    host.receive(
      ids[0],
      randomUUID(),
      { type: "transfer", kind: "abort", code: "x", message: "x" },
      empty,
    );
    expect((await readdir(dir)).map(partOwner).sort()).toEqual(["f0", "f1"]);
    host.abortAll();
    await Promise.all(opens);
    expect(await readdir(dir)).toEqual([]);
    expect(replies[0]).toHaveLength(1);
  });
});

describe("part files", () => {
  it("lets concurrent copies to one destination each finish verified without mixed bytes", async () => {
    const dir = await tempDir();
    const first = randomBytes(1024 * 1024 + 1);
    const second = randomBytes(1024 * 1024 + 2);
    await writeFile(join(dir, "first.bin"), first);
    await writeFile(join(dir, "second.bin"), second);
    const [a, b] = await Promise.all([
      copyThrough(join(dir, "first.bin"), join(dir, "copy.bin")),
      copyThrough(join(dir, "second.bin"), join(dir, "copy.bin")),
    ]);
    expect(a.received).toMatchObject({ status: "fulfilled", value: { sha256: sha(first) } });
    expect(b.received).toMatchObject({ status: "fulfilled", value: { sha256: sha(second) } });
    const result = await readFile(join(dir, "copy.bin"));
    expect(result.equals(first) || result.equals(second)).toBe(true);
    expect(await parts(dir)).toEqual([]);
  });

  it("creates each part file exclusively with mode 0600 next to the destination", async () => {
    const dir = await tempDir();
    const { part, handle } = await createPartFile(join(dir, "video.mp4"));
    await handle.close();
    expect(part).toMatch(/[\\/]\.video\.mp4\.[0-9a-f-]{36}\.rome-part$/);
    if (posix) expect((await stat(part)).mode & 0o777).toBe(0o600);
    const id = randomUUID();
    await writeFile(join(dir, `.taken.${id}.rome-part`), "keep");
    await expect(createPartFile(join(dir, "taken"), id)).rejects.toBeDefined();
    expect(await readFile(join(dir, `.taken.${id}.rome-part`), "utf8")).toBe("keep");
  });

  it.skipIf(!posix)("never follows a symlink at a part file name", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "victim.txt"), "secret");
    const id = randomUUID();
    await symlink(join(dir, "victim.txt"), join(dir, `.copy.bin.${id}.rome-part`));
    await expect(createPartFile(join(dir, "copy.bin"), id)).rejects.toBeDefined();
    // The fixed name an older version used, as a symlink, is not touched either.
    await symlink(join(dir, "victim.txt"), join(dir, "copy.bin.rome-part"));
    await writeFile(join(dir, "source.bin"), randomBytes(5000));
    const { received } = await copyThrough(join(dir, "source.bin"), join(dir, "copy.bin"));
    expect(received.status).toBe("fulfilled");
    expect(await readFile(join(dir, "victim.txt"), "utf8")).toBe("secret");
  });

  it("leaves a user file named like the old part file untouched", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "copy.bin.rome-part"), "user data");
    await writeFile(join(dir, "source.bin"), randomBytes(5000));
    const { received } = await copyThrough(join(dir, "source.bin"), join(dir, "copy.bin"));
    expect(received.status).toBe("fulfilled");
    expect(await readFile(join(dir, "copy.bin.rome-part"), "utf8")).toBe("user data");
    expect(await parts(dir)).toEqual([]);
  });

  it("flushes the part file to disk before the rename", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "source.bin"), randomBytes(5000));
    const probe = await open(join(dir, "source.bin"), "r");
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const sync = rs.spyOn(prototype, "sync");
    try {
      const { received } = await copyThrough(join(dir, "source.bin"), join(dir, "copy.bin"));
      expect(received.status).toBe("fulfilled");
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      sync.mockRestore();
    }
  });

  it.skipIf(!posix)(
    "keeps the mode of a replaced file and gives a new file the default mode",
    async () => {
      const dir = await tempDir();
      await writeFile(join(dir, "source.bin"), randomBytes(5000));
      for (const mode of [0o600, 0o755]) {
        const target = join(dir, `existing-${mode.toString(8)}`);
        await writeFile(target, "old");
        await chmod(target, mode);
        const { received } = await copyThrough(join(dir, "source.bin"), target);
        expect(received.status).toBe("fulfilled");
        expect((await stat(target)).mode & 0o777).toBe(mode);
      }
      await writeFile(join(dir, "reference"), "");
      const { received } = await copyThrough(join(dir, "source.bin"), join(dir, "new.bin"));
      expect(received.status).toBe("fulfilled");
      expect((await stat(join(dir, "new.bin"))).mode & 0o777).toBe(
        (await stat(join(dir, "reference"))).mode & 0o777,
      );
      expect((await readdir(dir)).some((file) => file.endsWith(".rome-mode"))).toBe(false);
    },
  );
});

describe("transfer limits and setup", () => {
  it("keeps every data frame within the Gateway frame limit", async () => {
    expect(TRANSFER_CHUNK_BYTES + FRAME_HEADER_BYTES + 1024).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    const dir = await tempDir();
    await writeFile(join(dir, "source.bin"), "x");
    const source = await openSource(join(dir, "source.bin"));
    expect(() =>
      source.start(() => true, { chunkBytes: MAX_FRAME_BYTES, windowBytes: MAX_FRAME_BYTES }),
    ).toThrow(RangeError);
  });

  it.skipIf(!posix)(
    "rejects a FIFO source at once on either side and keeps the host usable",
    async () => {
      const dir = await tempDir();
      execFileSync("mkfifo", [join(dir, "pipe")]);
      await expect(openSource(join(dir, "pipe"))).rejects.toMatchObject({ code: "not_a_file" });
      const host = new TransferHost({ limit: 4 });
      const pull = (n: number) =>
        copyWithDevice(hostChannels(host), {
          direction: "pull",
          localPath: join(dir, `back-${n}`),
          deviceId: caller,
          remotePath: join(dir, "pipe"),
        });
      // Two rounds that each fill every host slot show the refused FIFOs release their slots.
      for (const round of [0, 4]) {
        const results = await Promise.allSettled([1, 2, 3, 4].map((n) => pull(round + n)));
        for (const result of results)
          expect(result).toMatchObject({ status: "rejected", reason: { code: "not_a_file" } });
      }
      await expect(
        copyWithDevice(hostChannels(host), {
          direction: "push",
          localPath: join(dir, "pipe"),
          deviceId: caller,
          remotePath: join(dir, "remote"),
        }),
      ).rejects.toMatchObject({ code: "not_a_file" });
      await writeFile(join(dir, "regular"), "ok");
      await copyWithDevice(hostChannels(host), {
        direction: "pull",
        localPath: join(dir, "copied"),
        deviceId: caller,
        remotePath: join(dir, "regular"),
      });
      expect(await readFile(join(dir, "copied"), "utf8")).toBe("ok");
      expect(await parts(dir)).toEqual([]);
    },
  );

  it("does not send transfer.open when aborted during the local file open", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "local.bin"), randomBytes(5000));
    const actions: string[] = [];
    const controller = new AbortController();
    const copying = copyWithDevice(
      hostChannels(new TransferHost(), actions),
      {
        direction: "push",
        localPath: join(dir, "local.bin"),
        deviceId: caller,
        remotePath: join(dir, "remote.bin"),
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(copying).rejects.toMatchObject({ code: "canceled" });
    expect(actions).toEqual([]);
    expect(await readdir(dir)).toEqual(["local.bin"]);
  });

  it("does not send transfer.open when aborted during channel setup", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "remote.bin"), randomBytes(5000));
    for (const direction of ["push", "pull"] as const) {
      const actions: string[] = [];
      const controller = new AbortController();
      const channels = hostChannels(new TransferHost(), actions);
      const copying = copyWithDevice(
        async (events) => {
          const channel = await channels(events);
          controller.abort();
          return channel;
        },
        {
          direction,
          localPath: join(dir, direction === "push" ? "remote.bin" : "local.bin"),
          deviceId: caller,
          remotePath: join(dir, direction === "push" ? "pushed.bin" : "remote.bin"),
        },
        { signal: controller.signal },
      );
      await expect(copying).rejects.toMatchObject({ code: "canceled" });
      expect(actions).toEqual([]);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readdir(dir)).toEqual(["remote.bin"]);
  });
});
