import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export function toOriginRequest(req: IncomingMessage): {
  headers: { get(name: string): string | null };
  url: string;
} {
  const host = req.headers.host ?? "localhost";
  return {
    url: new URL(req.url ?? "/", `http://${host}`).toString(),
    headers: {
      get(name) {
        const value = req.headers[name.toLowerCase()];
        return Array.isArray(value) ? value.join(", ") : (value ?? null);
      },
    },
  };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = `${status} ${message}`;
  // end() flushes the response before closing; destroy() can truncate it.
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
}
