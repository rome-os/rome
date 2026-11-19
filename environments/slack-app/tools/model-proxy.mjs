// Stands between the instances and Anthropic's API. It pins every request to
// one model (Haiku 5.5 by default) whatever model Rome picked, and it adds the
// environment's credential, so the instances hold only a placeholder key and
// the real one never enters an instance, env.json or the repo.
//
// Env: MODEL_PROXY_PORT (8080), MODEL_PROXY_MODEL (claude-haiku-5-5),
// MODEL_PROXY_UPSTREAM (https://api.anthropic.com), and one credential:
// MODEL_PROXY_API_KEY (sent as x-api-key) or MODEL_PROXY_OAUTH_TOKEN (sent as
// a bearer token). GET /_stats answers how many requests went through, by the
// model Rome asked for.

import { createServer } from "node:http";

const port = Number(process.env.MODEL_PROXY_PORT ?? 8080);
const pinned = process.env.MODEL_PROXY_MODEL ?? "claude-haiku-5-5";
const upstream = (process.env.MODEL_PROXY_UPSTREAM ?? "https://api.anthropic.com").replace(
  /\/$/,
  "",
);
const apiKey = process.env.MODEL_PROXY_API_KEY ?? "";
const oauthToken = process.env.MODEL_PROXY_OAUTH_TOKEN ?? "";
const OAUTH_BETA = "oauth-2025-04-20";
const stats = { requests: 0, asked: {}, statuses: {} };

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
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;

  if (body.length && (req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      const json = JSON.parse(body.toString("utf8"));
      if (typeof json.model === "string") {
        stats.asked[json.model] = (stats.asked[json.model] ?? 0) + 1;
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
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
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
