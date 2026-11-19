// A minimal HTTP server for the stand-ins.

import { createServer } from "node:http";

/** Reads a request body as a string. */
export const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

/** Sends `body`: an object as JSON, anything else as `type`. */
export function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/** Serves `handler` on `port` (0 picks a free one). Errors answer 500. */
export function serve(handler, port = 0) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      try {
        await handler(req, res, url);
      } catch (err) {
        if (!res.headersSent) send(res, 500, { error: err.message });
      }
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
