import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import net from "node:net";
import { wechatUserDisplay } from "./channels/wechat-user.js";
import type { DrizzleDb } from "./db/index.js";
import { gateGuardianUpgrade } from "./lib/ws-guardian-gate.js";
import { rejectUpgrade } from "./lib/ws-upgrade.js";
import { createLogger } from "./logger.js";

const log = createLogger("desktop-proxy");

const PREFIX = "/desktop-proxy";
/** WeChat's own display (`WECHAT_USER_DISPLAY`), shown at /desktop/wechat. Same
 *  mount, same auth posture as the shared desktop: only the upstream differs. */
const WECHAT_PREFIX = `${PREFIX}/wechat`;

/** The websockify port and the path it sees, for a request under `/desktop-proxy`.
 *  Null for WeChat's view unless WeChat is enabled with its own display, the only
 *  case in which the entrypoint starts its websockify: nothing of ours listens on
 *  that port otherwise, and the shared websockify ignores the path. */
export function desktopUpstream(pathname: string): { port: number; path: string } | null {
  if (pathname === WECHAT_PREFIX || pathname.startsWith(`${WECHAT_PREFIX}/`)) {
    if (!ownDisplayActive()) return null;
    return {
      port: Number(process.env.ROME_WECHAT_NOVNC_PORT ?? 6081),
      path: pathname.slice(WECHAT_PREFIX.length) || "/",
    };
  }
  return {
    port: Number(process.env.ROME_NOVNC_PORT ?? 6080),
    path: pathname.slice(PREFIX.length) || "/",
  };
}

/** Fail closed: a value the shared rule rejects has no display of ours either. */
function ownDisplayActive(): boolean {
  try {
    return wechatUserDisplay() !== null;
  } catch {
    return false;
  }
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

export function attachDesktopProxy(httpServer: Server, db: DrizzleDb): { close(): void } {
  const host = "127.0.0.1";
  const upstreams = new Set<net.Socket>();

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const rawUrl = req.url ?? "/";
    if (!rawUrl.startsWith(`${PREFIX}/`) && rawUrl !== PREFIX) return;

    void gateGuardianUpgrade(req, socket, db)
      .then((allowed) => {
        if (!allowed) return;
        const target = desktopUpstream(rawUrl);
        if (!target) {
          rejectUpgrade(socket, 404, "Not Found");
          return;
        }
        const { port, path: targetPath } = target;
        const upstreamHost = `${host}:${port}`;
        const upstream = net.connect(port, host, () => {
          upstream.write(buildUpstreamUpgradeRequest(req, targetPath, upstreamHost));
          if (head.length > 0) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });

        upstreams.add(upstream);

        const teardown = () => {
          upstreams.delete(upstream);
          upstream.destroy();
          if (!socket.destroyed) socket.destroy();
        };

        upstream.on("error", (err) => {
          log.warn("upstream websockify error", { error: err.message });
          if (!socket.destroyed) socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          teardown();
        });
        upstream.on("close", teardown);
        socket.on("error", teardown);
        socket.on("close", teardown);
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
