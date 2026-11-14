// The browser's only way out. Chrome is started with this as its proxy, for
// loopback addresses too, so every request the dashboard makes passes here.
// That gives the environment two things a guardian's browser does not have:
// a switch that cuts the network, and a record of what went where.
//
//   node proxy.mjs --port 4783
//
// Control, on the same port with an ordinary (non-proxy) request:
//   GET  /__voice-env/state            {"cut":false,"capturing":false}
//   POST /__voice-env/cut              drop every open connection, refuse new ones
//   POST /__voice-env/restore          accept connections again
//   POST /__voice-env/capture/start    start a fresh record
//   POST /__voice-env/capture/stop     end the record and return it
//
// Bytes are counted and dropped. The only part of a request kept is its
// method, address, headers' content type and the first bytes needed to tell
// whether it carried audio.
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { classify, frameParser } from "./audio.mjs";

const portArg = process.argv.indexOf("--port");
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : 4783);

let cut = false;
let capture = null;
const live = new Set();
let nextId = 1;

function record(entry) {
  entry.id = nextId++;
  entry.startedAt = Date.now();
  entry.bytesUp = 0;
  entry.bytesDown = 0;
  entry.upBySecond = {};
  entry.sockets = [];
  if (capture) capture.entries.push(entry);
  live.add(entry);
  return entry;
}

function countUp(entry, n) {
  entry.bytesUp += n;
  const s = Math.floor(Date.now() / 1000);
  entry.upBySecond[s] = (entry.upBySecond[s] ?? 0) + n;
  if (capture && !capture.entries.includes(entry)) capture.entries.push(entry);
}

function close(entry) {
  entry.endedAt ??= Date.now();
  live.delete(entry);
}

function cutAll() {
  for (const entry of live) {
    for (const s of entry.sockets) s.destroy();
    entry.cutAt = Date.now();
    close(entry);
  }
}

function report() {
  const window = {
    start: new Date(capture.startedAt).toISOString(),
    end: new Date().toISOString(),
  };
  const requests = capture.entries.map((e) => {
    const { sockets, upBySecond, frames, sniff, ...rest } = e;
    const verdict = classify(e);
    return {
      ...rest,
      startedAt: new Date(e.startedAt).toISOString(),
      endedAt: e.endedAt ? new Date(e.endedAt).toISOString() : null,
      cutAt: e.cutAt ? new Date(e.cutAt).toISOString() : undefined,
      ...(frames && { webSocket: frames.summary() }),
      carriesAudio: verdict.audio,
      evidence: verdict.evidence,
    };
  });
  return { window, requests };
}

function control(req, res) {
  const path = new URL(req.url, "http://x").pathname.replace("/__voice-env", "");
  const reply = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && path === "/state") return reply({ cut, capturing: Boolean(capture) });
  if (req.method === "POST" && path === "/cut") {
    cut = true;
    cutAll();
    return reply({ cut });
  }
  if (req.method === "POST" && path === "/restore") {
    cut = false;
    return reply({ cut });
  }
  if (req.method === "POST" && path === "/capture/start") {
    capture = { startedAt: Date.now(), entries: [] };
    return reply({ capturing: true });
  }
  if (req.method === "POST" && path === "/capture/stop") {
    if (!capture) return reply({ window: null, requests: [] });
    const out = report();
    capture = null;
    return reply(out);
  }
  res.writeHead(404).end();
}

const server = createServer((req, res) => {
  if (req.url.startsWith("/__voice-env/")) return control(req, res);
  if (cut) return req.socket.destroy();
  let target;
  try {
    target = new URL(req.url);
  } catch {
    return res.writeHead(400).end();
  }
  const entry = record({
    kind: "http",
    method: req.method,
    url: `${target.origin}${target.pathname}`,
    host: target.host,
    contentType: req.headers["content-type"] ?? null,
  });
  entry.sniff = Buffer.alloc(0);
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  const upstream = httpRequest(
    {
      host: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers,
    },
    (up) => {
      entry.status = up.statusCode;
      res.writeHead(up.statusCode, up.headers);
      up.on("data", (d) => (entry.bytesDown += d.length));
      up.pipe(res);
      up.on("end", () => close(entry));
    },
  );
  entry.sockets.push(req.socket);
  upstream.on("socket", (s) => entry.sockets.push(s));
  upstream.on("error", () => {
    close(entry);
    res.destroy();
  });
  req.on("data", (d) => {
    countUp(entry, d.length);
    if (entry.sniff.length < 65536)
      entry.sniff = Buffer.concat([entry.sniff, d.subarray(0, 65536)]);
  });
  req.pipe(upstream);
});

// HTTPS, and WebSockets, which Chrome always tunnels.
server.on("connect", (req, client, head) => {
  if (cut) return client.destroy();
  const [host, port] = req.url.split(":");
  const entry = record({ kind: "tunnel", host: req.url, tls: null });
  const upstream = connect(Number(port) || 443, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) onUp(head);
    client.on("data", onUp);
    upstream.pipe(client);
  });
  entry.sockets.push(client, upstream);
  // The first bytes say whether this is TLS. A plain tunnel carries an HTTP
  // request, often a WebSocket upgrade, whose frames are counted by type.
  let headBuf = Buffer.alloc(0);
  function onUp(d) {
    countUp(entry, d.length);
    if (entry.tls === null) entry.tls = d[0] === 0x16;
    if (!entry.tls && !entry.request) {
      headBuf = Buffer.concat([headBuf, d]);
      const end = headBuf.indexOf("\r\n\r\n");
      if (end >= 0) {
        const lines = headBuf.subarray(0, end).toString("latin1").split("\r\n");
        const [method, path] = lines[0].split(" ");
        const upgrade = lines.some((l) => /^upgrade:\s*websocket/i.test(l));
        entry.request = { method, path, upgrade };
        const ct = lines.find((l) => /^content-type:/i.test(l));
        if (ct) entry.contentType = ct.split(":")[1].trim();
        const rest = headBuf.subarray(end + 4);
        if (upgrade) {
          entry.frames = frameParser();
          if (rest.length) entry.frames.push(rest);
        } else entry.sniff = rest.subarray(0, 65536);
      }
    } else if (entry.frames) entry.frames.push(d);
    upstream.write(d);
  }
  upstream.on("data", (d) => (entry.bytesDown += d.length));
  const end = () => {
    close(entry);
    client.destroy();
    upstream.destroy();
  };
  upstream.on("error", end).on("close", end);
  client.on("error", end).on("close", end);
});

// A WebSocket sent to the proxy without CONNECT: pass it through as a tunnel.
server.on("upgrade", (req, client, head) => {
  if (cut) return client.destroy();
  const target = new URL(req.url);
  const entry = record({
    kind: "tunnel",
    host: target.host,
    tls: false,
    request: { method: req.method, path: target.pathname, upgrade: true },
  });
  entry.frames = frameParser();
  const upstream = connect(Number(target.port) || 80, target.hostname, () => {
    const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) client.unshift(head);
    client.on("data", (d) => {
      countUp(entry, d.length);
      entry.frames.push(d);
      upstream.write(d);
    });
    upstream.pipe(client);
  });
  entry.sockets.push(client, upstream);
  upstream.on("data", (d) => (entry.bytesDown += d.length));
  const end = () => {
    close(entry);
    client.destroy();
    upstream.destroy();
  };
  upstream.on("error", end).on("close", end);
  client.on("error", end).on("close", end);
});

server.listen(PORT, "127.0.0.1", () => console.log(`voice-env proxy on 127.0.0.1:${PORT}`));
