// Answers HTTPS for public host names inside the live mode's network, so a
// server-side call to https://<name>.romeos.dev stays in the network instead
// of going out through Cloudflare Access. It ends TLS with the environment's
// own certificate, which the containers trust through NODE_EXTRA_CA_CERTS,
// and passes each request on by its Host header.
//
// Usage: node tls-proxy.mjs <cert> <key> <port>[,<port>...] <host>=<target-host>:<port> ...

import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";

export function startTlsProxy({ cert, key, port, routes }) {
  const target = (req) => routes.get(String(req.headers.host ?? "").replace(/:\d+$/, ""));
  const server = createServer({ cert, key }, (req, res) => {
    const to = target(req);
    if (!to) {
      res.writeHead(404, { "content-type": "text/plain" }).end(`no route for ${req.headers.host}`);
      return;
    }
    const upstream = request(
      {
        host: to.host,
        port: to.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, "x-forwarded-proto": "https" },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`upstream ${to.host}:${to.port}: ${error.message}`);
    });
    req.pipe(upstream);
  });
  // A WebSocket upgrade goes on as raw bytes once the request line is replayed.
  server.on("upgrade", (req, socket, head) => {
    const to = target(req);
    if (!to) return socket.destroy();
    const upstream = connect(to.port, to.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", close);
    upstream.on("error", close);
  });
  return server.listen(port);
}

export function parseRoutes(specs) {
  return new Map(
    specs.map((spec) => {
      const [name, to] = spec.split("=");
      const [host, port] = to.split(":");
      return [name, { host, port: Number(port) }];
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // <port> may list several, comma separated: one listener each, same routes.
  const [cert, key, ports, ...specs] = process.argv.slice(2);
  const routes = parseRoutes(specs);
  for (const port of ports.split(",").map(Number)) {
    startTlsProxy({
      cert: readFileSync(cert),
      key: readFileSync(key),
      port,
      routes,
    }).on("listening", () => console.log(`tls-proxy on ${port}: ${[...routes.keys()].join(", ")}`));
  }
}
