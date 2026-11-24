// The team verifier's network. While an instance is open, every outgoing
// connection in the process reaches only a loopback port the verifier started
// a server on and allowed: the instance itself and the stand-in Rome Cloud. A
// route that calls anything else, such as Chrome's debugging port or a
// provider, gets a network error, so a run never touches a real service on
// the developer's machine or the internet.
//
// The guard sits on `net.Socket.prototype.connect`, which `fetch`,
// `node:http`, `node:tls` and WebSocket clients all go through.

import { Socket } from "node:net";

const allowedPorts = new Set<number>();
let openInstances = 0;
let unguardedConnect: Socket["connect"] | undefined;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

type Destination = { host: string; port: number } | { path: string };

/** Lets connections reach `port` on loopback. Call it for a server the
 *  verifier started; the returned function takes the permission back. */
export function allowVerifierServer(port: number): () => void {
  allowedPorts.add(port);
  return () => {
    allowedPorts.delete(port);
  };
}

/** Turns the guard on for one open instance. The returned function turns it
 *  off once every instance that turned it on has called it. */
export function guardNetwork(): () => void {
  openInstances += 1;
  if (!unguardedConnect) {
    const connect = Socket.prototype.connect;
    unguardedConnect = connect;
    Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
      const destination = destinationOf(args);
      if (!isAllowed(destination)) {
        const where =
          "path" in destination ? destination.path : `${destination.host}:${destination.port}`;
        // Failing on the next tick, as a refused connection does, lets the
        // caller attach its error listener first.
        process.nextTick(() =>
          this.destroy(new Error(`the team verifier keeps ${where} unreachable`)),
        );
        return this;
      }
      return (connect as (...a: unknown[]) => Socket).apply(this, args);
    } as Socket["connect"];
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openInstances -= 1;
    if (openInstances === 0 && unguardedConnect) {
      Socket.prototype.connect = unguardedConnect;
      unguardedConnect = undefined;
    }
  };
}

function isAllowed(destination: Destination): boolean {
  if ("path" in destination) return false;
  return LOOPBACK_HOSTS.has(destination.host) && allowedPorts.has(destination.port);
}

// `Socket#connect` takes `(options)`, `(port, host?)` or `(path)`, and
// `net.connect` hands it its arguments already normalized into an array.
function destinationOf(args: unknown[]): Destination {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: string; port?: number | string; path?: string };
    if (options.path) return { path: String(options.path) };
    return { host: options.host ?? "localhost", port: Number(options.port) };
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(first) };
  }
  return { path: String(first) };
}
