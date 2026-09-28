import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createLogger } from "../../../logger.js";
import { createPlaygroundPeer, type PlaygroundPeer } from "./playground-peer.js";

export const playgroundConfig = z
  .object({
    platform: z.enum(["discord", "telegram", "feishu", "wechat"]),
    mode: z.enum(["edit", "blocks", "final"]),
    chunkSize: z.number().int().min(2).max(4096),
    step: z.number().int().min(1).max(512),
    intervalMs: z.number().int().min(0).max(2000),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.platform === "wechat" && config.mode === "edit")
      context.addIssue({ code: "custom", message: "WeChat is append-only", path: ["mode"] });
    const limit = { discord: 1900, telegram: 4000, feishu: 3500, wechat: 1800 }[config.platform];
    if (config.chunkSize > limit)
      context.addIssue({
        code: "custom",
        message: `This preset supports a chunk size up to ${limit}`,
        path: ["chunkSize"],
      });
  });
const commandSchema = z
  .object({
    action: z.enum(["send", "stream", "inbound"]),
    text: z.string().min(1).max(10000),
    fault: z.enum(["none", "reject", "drop", "rate-limit"]).default("none"),
  })
  .strict();
export const playgroundPresets = {
  discord: { platform: "discord", mode: "edit", chunkSize: 1900, step: 12, intervalMs: 150 },
  telegram: { platform: "telegram", mode: "edit", chunkSize: 4000, step: 12, intervalMs: 150 },
  feishu: { platform: "feishu", mode: "edit", chunkSize: 1000, step: 12, intervalMs: 150 },
  wechat: { platform: "wechat", mode: "blocks", chunkSize: 1000, step: 12, intervalMs: 150 },
} as const;

export async function startPlayground(port = 0) {
  let config = playgroundConfig.parse(playgroundPresets.telegram);
  let peer: PlaygroundPeer | undefined;
  let busy = false;
  let error = "";
  let cancelled = false;
  let task: Promise<void> = Promise.resolve();
  let sequence = 0;
  const order = new Map<string, number>();
  const incoming: {
    id: string;
    text: string;
    edited: boolean;
    direction: string;
    order: number;
  }[] = [];
  const receive = (text: string) =>
    incoming.push({
      id: `in-${++sequence}`,
      text,
      edited: false,
      direction: "in",
      order: sequence,
    });
  const snapshot = () => ({
    config,
    presets: playgroundPresets,
    busy,
    error,
    messages: [
      ...incoming,
      ...(peer?.messages() ?? []).map((m) => {
        if (!order.has(m.id)) order.set(m.id, ++sequence);
        return { ...m, direction: "out", order: order.get(m.id)! };
      }),
    ].sort((a, b) => a.order - b.order),
    calls: peer?.server.calls.slice(-200) ?? [],
    errors: (peer?.server.errors ?? []).map(() => "Fixture request failed"),
    receipts: peer?.receipts() ?? [],
  });
  const open = async (next: typeof config) => {
    await peer?.close();
    peer = undefined;
    incoming.length = 0;
    order.clear();
    sequence = 0;
    config = next;
    peer = await createPlaygroundPeer(config, receive);
  };
  await open(config);
  const run = async (command: z.infer<typeof commandSchema>) => {
    const current = peer!;
    if (command.action === "inbound") {
      await current.inbound(command.text);
      return;
    }
    const faults = {
      drop: { dropAfterAccept: true },
      "rate-limit": {
        response: {
          status: 429,
          headers: { "retry-after": "1" },
          body: {
            message: "Rate limited",
            retry_after: 1,
            global: false,
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 1 },
            code: 99991400,
            msg: "Rate limited",
            ret: -1,
            errmsg: "Rate limited",
          },
        },
      },
      reject: {
        response: {
          status: 403,
          body: {
            message: "Forbidden",
            ok: false,
            error_code: 403,
            description: "Forbidden",
            code: 99991672,
            msg: "Forbidden",
            ret: -1,
            errmsg: "Forbidden",
          },
        },
      },
    };
    if (command.fault !== "none")
      current.server.once({ ...current.mutation(), ...faults[command.fault] });
    if (command.action === "send") {
      await current.send(command.text);
      return;
    }
    const run = await current.startRun();
    try {
      const points = Array.from(command.text);
      for (let offset = 0; offset < points.length && !cancelled; offset += config.step) {
        run.append(points.slice(offset, offset + config.step).join(""), "answer");
        await delay(config.intervalMs, undefined, { signal: run.signal });
      }
      if (!cancelled) {
        run.complete(command.text, "final", "answer");
        await current.finishRun(command.text);
      }
    } finally {
      await current.stop();
    }
  };
  let origin = "";
  const server = createServer((req, res) => {
    void (async () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
      };
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return json(403, { error: "Use the local playground origin" });
      if (req.method === "GET" && req.url === "/state") return json(200, snapshot());
      if (req.method !== "POST" || !["/config", "/run", "/stop"].includes(req.url ?? ""))
        return json(404, { error: "Not found" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(415, { error: "Expected JSON" });
      if (req.url === "/stop") {
        cancelled = true;
        await peer?.stop();
        return json(200, { ok: true });
      }
      if (busy) return json(409, { error: "Wait for the current operation or stop it" });
      busy = true;
      try {
        const buffers: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 65536) {
            json(413, { error: "Request too large" });
            return;
          }
          buffers.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(buffers).toString());
        if (req.url === "/config") {
          const next = playgroundConfig.parse(body);
          await open(next);
          error = "";
          return json(200, snapshot());
        }
        const command = commandSchema.parse(body);
        if (!peer) throw new Error("Reset the playground before running a command");
        if (peer.server.calls.length >= 1000)
          throw new Error("Reset the session after 1,000 requests");
        cancelled = false;
        error = "";
        task = run(command)
          .catch((failure) => {
            if (!cancelled)
              error = "Delivery failed. Inspect the request timeline for the provider outcome.";
            createLogger("im-playground").warn("Playground operation failed", {
              error: String(failure),
            });
          })
          .finally(() => {
            busy = false;
          });
        json(202, { ok: true });
        return;
      } catch (failure) {
        json(400, {
          error:
            failure instanceof z.ZodError
              ? "Invalid playground configuration or command"
              : "Playground operation failed",
        });
      } finally {
        if (req.url !== "/run" || !res.writableEnded || res.statusCode !== 202) busy = false;
      }
    })().catch(() => {
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  server.listen(port, "127.0.0.1");
  try {
    await once(server, "listening");
  } catch (failure) {
    await peer?.close();
    throw failure;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing playground address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    close: async () => {
      cancelled = true;
      await peer?.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await task;
      await peer?.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startPlayground(Number(process.argv[2] ?? 3211));
  createLogger("im-playground").info(`IM playground: ${app.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
}
