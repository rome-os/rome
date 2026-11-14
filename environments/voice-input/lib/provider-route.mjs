// The route from Rome to the real transcriber, which a check can cut in the
// middle of a message. It listens on the environment's network under the
// provider's own host name, so Rome dials it as it would dial Soniox, and
// passes the bytes through to Soniox unread: TLS runs end to end between
// Rome and Soniox.
//
//   node provider-route.mjs   (env: ROUTE_UPSTREAM=ip[,ip...], ROUTE_PORT=443)
//
// Control on port 8792:
//   POST /cut       closes every open connection and refuses new ones
//   POST /restore   accepts connections again
//   GET  /stats     {cut, open, connections: [{opened, closed, closedBy, bytesUp, bytesDown}]}
import { createServer as createHttpServer } from "node:http";
import { connect, createServer } from "node:net";

const upstream = (process.env.ROUTE_UPSTREAM ?? "").split(",").filter(Boolean);
if (upstream.length === 0) throw new Error("ROUTE_UPSTREAM is empty");
const port = Number(process.env.ROUTE_PORT ?? 443);

let cut = false;
const open = new Set();
const connections = [];

createServer((client) => {
  const record = {
    opened: new Date().toISOString(),
    closed: null,
    closedBy: null,
    bytesUp: 0,
    bytesDown: 0,
  };
  connections.push(record);
  if (cut) {
    record.closed = record.opened;
    record.closedBy = "cut";
    client.destroy();
    return;
  }
  const server = connect(port, upstream[connections.length % upstream.length]);
  const pair = { client, server, record };
  open.add(pair);
  client.on("data", (d) => (record.bytesUp += d.length));
  server.on("data", (d) => (record.bytesDown += d.length));
  client.pipe(server);
  server.pipe(client);
  const close = (by) => {
    if (!open.delete(pair)) return;
    record.closed = new Date().toISOString();
    record.closedBy ??= by;
    client.destroy();
    server.destroy();
  };
  client.on("close", () => close("rome"));
  client.on("error", () => close("rome"));
  server.on("close", () => close("provider"));
  server.on("error", () => close("provider"));
}).listen(port, "0.0.0.0");

createHttpServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(`${JSON.stringify(body)}\n`);
  };
  if (req.method === "POST" && req.url === "/cut") {
    cut = true;
    // A reset, as a dropped route looks to Rome, not a clean close.
    for (const pair of [...open]) {
      pair.record.closedBy = "cut";
      pair.client.resetAndDestroy();
      pair.server.destroy();
    }
    return reply(200, { cut, closed: connections.filter((c) => c.closedBy === "cut").length });
  }
  if (req.method === "POST" && req.url === "/restore") {
    cut = false;
    return reply(200, { cut });
  }
  if (req.method === "GET" && req.url === "/stats")
    return reply(200, { cut, open: open.size, connections });
  reply(404, { error: "not_found" });
}).listen(8792, "0.0.0.0");
