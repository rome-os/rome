import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import net from "node:net";
import type { DrizzleDb } from "./db/index.js";
import { gateGuardianUpgrade } from "./lib/ws-guardian-gate.js";
import { rejectUpgrade } from "./lib/ws-upgrade.js";
import { type DesktopManager, isDesktopName } from "./desktops/manager.js";
import { createLogger } from "./logger.js";

const log = createLogger("desktop-proxy");

const PREFIX = "/desktop-proxy";

/**
 * The websockify port and the path it sees, for an upgrade under `/desktop-proxy`.
 * `/desktop-proxy/<name>` and everything under it go to that named desktop,
 * and resolve to null when it is not running. Every other path goes to the
 * shared desktop, whose websockify ignores the path.
 */
export async function desktopUpstream(
  rawUrl: string,
  desktops: Pick<DesktopManager, "get">,
): Promise<{ port: number; path: string } | null> {
  const rest = rawUrl.slice(PREFIX.length);
  const named = /^\/([^/?]+)(.*)$/.exec(rest);
  if (named && isDesktopName(named[1]!)) {
    const desktop = await desktops.get(named[1]!);
    if (!desktop) return null;
    const tail = named[2]!;
    return { port: desktop.novncPort, path: tail.startsWith("/") ? tail : `/${tail}` };
  }
  return {
    port: Number(process.env.ROME_NOVNC_PORT ?? 6080),
    path: rest || "/",
  };
}

function buildUpstreamUpgradeRequest(
  req: IncomingMessage,
  targetPath: string,
  upstreamHost: string,
): string {
  const lines: string[] = [];
  lines.push(`${req.method ?? "GET"} ${targetPath} HTTP/1.1`);
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (key.toLowerCase() === "host") {
      lines.push(`Host: ${upstreamHost}`);
      continue;
    }
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`${key}: ${v}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

export function attachDesktopProxy(
  httpServer: Server,
  db: DrizzleDb,
  desktops: Pick<DesktopManager, "get">,
): { close(): void } {
  const host = "127.0.0.1";
  const upstreams = new Set<net.Socket>();

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const rawUrl = req.url ?? "/";
    if (!rawUrl.startsWith(`${PREFIX}/`) && rawUrl !== PREFIX) return;

    let upstream: net.Socket | undefined;
    const teardown = () => {
      if (upstream) {
        upstreams.delete(upstream);
        upstream.destroy();
      }
      if (!socket.destroyed) socket.destroy();
    };
    socket.on("error", teardown);
    socket.on("close", teardown);

    void gateGuardianUpgrade(req, socket, db)
      .then(async (allowed) => {
        if (!allowed || socket.destroyed) return;
        const target = await desktopUpstream(rawUrl, desktops);
        if (socket.destroyed) return;
        if (!target) {
          rejectUpgrade(socket, 404, "Not Found");
          return;
        }
        const { port, path: targetPath } = target;
        const upstreamHost = `${host}:${port}`;
        const connected = net.connect(port, host);
        upstream = connected;
        upstreams.add(connected);
        connected.on("connect", () => {
          if (socket.destroyed) return teardown();
          connected.write(buildUpstreamUpgradeRequest(req, targetPath, upstreamHost));
          if (head.length > 0) connected.write(head);
          socket.pipe(connected);
          connected.pipe(socket);
        });

        connected.on("error", (err) => {
          log.warn("upstream websockify error", { error: err.message });
          if (!socket.destroyed) socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          teardown();
        });
        connected.on("close", teardown);
      })
      .catch((err) => {
        log.error("desktop upgrade failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        rejectUpgrade(socket, 500, "Internal Server Error");
      });
  });

  return {
    close() {
      for (const upstream of upstreams) upstream.destroy();
      upstreams.clear();
    },
  };
}
