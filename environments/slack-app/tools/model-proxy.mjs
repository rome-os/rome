// Stands between the instances and Anthropic's API. It pins every request to
// one model (Opus 5.5 by default) whatever model Rome picked, keeps the effort
// Rome asked for, and adds the environment's credential, so the instances hold
// only a placeholder key and the real one never enters an instance, env.json
// or the repo.
//
// Env: MODEL_PROXY_PORT (8080), MODEL_PROXY_MODEL (claude-opus-5-5),
// MODEL_PROXY_UPSTREAM (https://api.anthropic.com), and one credential:
// MODEL_PROXY_API_KEY (sent as x-api-key) or MODEL_PROXY_OAUTH_TOKEN (sent as
// a bearer token). GET /_stats answers how many requests went through, by the
// model Rome asked for and by the model and effort sent. GET
// /_usage?since=&until= answers the tokens the upstream reported for messages
// in that span, and their cost at list prices (usage.mjs).
//
// With MODEL_PROXY_CONTROL_PORT set (the isolated environment only, never the
// live stack), it also answers ctl.sh port's scripted turns itself
// (port-script.mjs), and that port, published to the host alone, takes the
// jobs: POST /_port, GET and DELETE /_port/<nonce>. It forwards nothing.

import { createServer } from "node:http";
import { createUsage } from "./usage.mjs";

const port = Number(process.env.MODEL_PROXY_PORT ?? 8080);
const pinned = process.env.MODEL_PROXY_MODEL || "claude-opus-5-5";
const upstream = (process.env.MODEL_PROXY_UPSTREAM ?? "https://api.anthropic.com").replace(
  /\/$/,
  "",
);
const apiKey = process.env.MODEL_PROXY_API_KEY ?? "";
const oauthToken = process.env.MODEL_PROXY_OAUTH_TOKEN ?? "";
const OAUTH_BETA = "oauth-2025-04-20";
const stats = { requests: 0, asked: {}, sent: {}, statuses: {}, scripted: 0 };
const usage = createUsage();
const controlPort = process.env.MODEL_PROXY_CONTROL_PORT;
const script = controlPort
  ? (await import("./port-script.mjs")).createPortScript({ model: pinned })
  : null;

// Headers that must not be forwarded as they are.
const HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "accept-encoding",
]);

createServer(async (req, res) => {
  if (req.url.startsWith("/_usage")) return answerUsage(req, res);
  if (req.url === "/_stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        pinned,
        credential: apiKey ? "api_key" : oauthToken ? "oauth" : "none",
        ...stats,
      }),
    );
  }
  const chunks = [];
  try {
    for await (const c of req) chunks.push(c);
  } catch {
    // The instance went away mid-upload: nothing to forward or answer.
    return res.destroy();
  }
  let body = Buffer.concat(chunks);
  // What one message turn cost, filled from the upstream's answer.
  let turn = null;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;

  if (body.length && (req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      const json = JSON.parse(body.toString("utf8"));
      const scripted = script?.answer(json);
      if (scripted) {
        stats.scripted += 1;
        if (req.url.startsWith("/v1/messages/count_tokens") && scripted.status === 200) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end('{"input_tokens":1}');
        }
        res.writeHead(scripted.status, scripted.headers);
        return res.end(scripted.body);
      }
      if (typeof json.model === "string") {
        stats.asked[json.model] = (stats.asked[json.model] ?? 0) + 1;
        const effort = json.output_config?.effort ?? "unset";
        const sent = `${pinned} ${effort}`;
        stats.sent[sent] = (stats.sent[sent] ?? 0) + 1;
        if (req.url.split("?")[0] === "/v1/messages") {
          turn = { asked: json.model, model: pinned, effort };
        }
        json.model = pinned;
        body = Buffer.from(JSON.stringify(json));
      }
    } catch {
      // Not JSON after all: forward untouched.
    }
  }
  // The 1M-token context beta is not offered on every model; the pinned one
  // answers without it.
  if (typeof headers["anthropic-beta"] === "string") {
    const kept = headers["anthropic-beta"]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("context-1m"));
    if (kept.length) headers["anthropic-beta"] = kept.join(",");
    else delete headers["anthropic-beta"];
  }
  if (apiKey) {
    headers["x-api-key"] = apiKey;
    delete headers.authorization;
  } else if (oauthToken) {
    // A subscription token is accepted only with the OAuth beta, which the
    // instances, holding a placeholder API key, never send themselves.
    headers.authorization = `Bearer ${oauthToken}`;
    delete headers["x-api-key"];
    const betas = String(headers["anthropic-beta"] ?? "")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
    headers["anthropic-beta"] = betas.join(",");
  }

  stats.requests += 1;
  try {
    const response = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    stats.statuses[response.status] = (stats.statuses[response.status] ?? 0) + 1;
    const out = {};
    response.headers.forEach((v, k) => {
      if (!HOP.has(k) && k !== "content-encoding") out[k] = v;
    });
    res.writeHead(response.status, out);
    const reading = turn ? usage.reader(response.headers.get("content-type")) : null;
    if (response.body) {
      for await (const chunk of response.body) {
        reading?.push(chunk);
        res.write(chunk);
      }
    }
    res.end();
    if (reading) usage.record({ ...turn, status: response.status, ...reading.tokens() });
  } catch (error) {
    stats.statuses.error = (stats.statuses.error ?? 0) + 1;
    console.error(JSON.stringify({ msg: "upstream request failed", error: String(error) }));
    // Cut off mid-stream: the status is sent already, so end this response
    // broken rather than answer twice, which would throw and stop the proxy.
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "proxy_error", message: "upstream request failed" },
      }),
    );
  }
}).listen(port, () =>
  console.log(JSON.stringify({ msg: "model proxy listening", port, pinned, upstream })),
);

function answerUsage(req, res) {
  const q = new URL(req.url, "http://proxy").searchParams;
  const out = usage.report(q.get("since"), q.get("until"));
  res.writeHead(out.error ? 400 : 200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
}

if (script) {
  createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const nonce = req.url.match(/^\/_port\/([a-z0-9]+)$/)?.[1];
    if (req.method === "GET" && req.url === "/_stats") return send(200, stats);
    if (req.method === "GET" && req.url.startsWith("/_usage")) return answerUsage(req, res);
    if (req.method === "POST" && req.url === "/_port") {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(400, { error: "the job must be JSON" });
      }
      const out = script.register(body);
      return send(out.status, out.body);
    }
    if (nonce && req.method === "GET") {
      const job = script.job(nonce);
      return job ? send(200, job) : send(404, { error: `no job ${nonce}` });
    }
    if (nonce && req.method === "DELETE") return send(200, { removed: script.remove(nonce) });
    send(404, { error: "not found" });
  }).listen(Number(controlPort), () =>
    console.log(JSON.stringify({ msg: "model proxy control listening", port: controlPort })),
  );
}
