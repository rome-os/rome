import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import net from "node:net";
import { createLogger } from "./logger.js";

const log = createLogger("desktop-proxy");

const PREFIX = "/desktop-proxy";
/** WeChat's own display (`WECHAT_USER_DISPLAY`), shown at /desktop/wechat. Same
 *  mount, same auth posture as the shared desktop: only the upstream differs. */
const WECHAT_PREFIX = `${PREFIX}/wechat`;

/** The websockify port and the path it sees, for a request under `/desktop-proxy`.
 *  Null for WeChat's view while no WeChat display is configured: nothing of ours
 *  listens on its port then, and the shared websockify ignores the path. */
export function desktopUpstream(pathname: string): { port: number; path: string } | null {
  if (pathname === WECHAT_PREFIX || pathname.startsWith(`${WECHAT_PREFIX}/`)) {
    if (!process.env.WECHAT_USER_DISPLAY) return null;
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

export function attachDesktopProxy(httpServer: Server): { close(): void } {
  const host = "127.0.0.1";
  const upstreams = new Set<net.Socket>();

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const rawUrl = req.url ?? "/";
    if (!rawUrl.startsWith(`${PREFIX}/`) && rawUrl !== PREFIX) return;

    const target = desktopUpstream(rawUrl);
    if (!target) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const { port, path: targetPath } = target;
    const upstreamHost = `${host}:${port}`;

    const upstream = net.connect(port, host, () => {
      upstream.write(buildUpstreamUpgradeRequest(req, targetPath, upstreamHost));
      if (head && head.length > 0) upstream.write(head);
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
      if (!socket.destroyed) {
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      teardown();
    });
    upstream.on("close", teardown);
    socket.on("error", teardown);
    socket.on("close", teardown);
  });

  return {
    close() {
      for (const upstream of upstreams) upstream.destroy();
      upstreams.clear();
    },
  };
}

export async function proxyDesktopHttp(req: Request): Promise<Response> {
  const incoming = new URL(req.url);
  const target = desktopUpstream(incoming.pathname);
  if (!target) return new Response("Not Found", { status: 404 });
  const { port, path: targetPath } = target;
  const upstreamUrl = `http://127.0.0.1:${port}${targetPath}${incoming.search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("host", `127.0.0.1:${port}`);

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  try {
    const response = await fetch(upstreamUrl, init);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    log.warn("desktop http proxy failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("Bad Gateway", { status: 502 });
  }
}
