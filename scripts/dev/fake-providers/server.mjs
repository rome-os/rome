#!/usr/bin/env node
// Fake model providers for walking provider failures on a dev stack, with no
// real account. It answers two APIs on one port:
// - Anthropic Messages (`/v1/messages`), reached through AI Tools' custom
//   Claude-compatible provider (base URL http://host.docker.internal:<port>).
// - ChatGPT's Codex backend (`/backend-api/...`), reached by pointing Codex's
//   own config at it (see use-fake-chatgpt.sh).
// Codex reaches ChatGPT only over https, so with `--tls <dir>` (from
// make-tls.sh) the same server also listens with TLS on <port>+1, and on 443
// for the token refresh Codex sends to auth.openai.com, which
// use-fake-chatgpt.sh points at this host inside the stack's container.
// POST /control {"provider":"claude"|"chatgpt","mode":"<mode>"} sets a sticky
// mode per provider; GET /control reads them. Modes:
//   ok | rate | overloaded | model_limit | usage | model_gone | auth | spend
// Dev only: nothing in Rome refers to it.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

const port = Number(process.argv[2] ?? 18765);
const tlsAt = process.argv.indexOf("--tls");
const tlsDir = tlsAt > 0 ? process.argv[tlsAt + 1] : null;
const modes = { claude: "ok", chatgpt: "ok" };
// In `model_limit`, only the first model asked for is refused: a per-model
// limit leaves the provider's other models running.
const limited = { claude: null, chatgpt: null };
function refused(provider, model) {
  if (modes[provider] !== "model_limit") return true;
  limited[provider] ??= model;
  return limited[provider] === model;
}
let served = 0;
const now = () => Math.floor(Date.now() / 1000);
const resetIn = 2 * 3600;

const claudeErrors = {
  rate: [429, "rate_limit_error", "Rate limited, please slow down"],
  overloaded: [529, "overloaded_error", "Overloaded"],
  model_limit: [429, "rate_limit_error", "You've hit your Opus limit"],
  usage: [429, "rate_limit_error", "Claude usage limit reached. Your limit will reset at 5pm"],
  model_gone: [404, "not_found_error", "model: the requested model does not exist"],
  auth: [401, "authentication_error", "invalid x-api-key"],
  spend: [429, "rate_limit_error", "You have reached your monthly spend limit"],
};

const chatgptErrors = {
  rate: [429, { type: "rate_limit_exceeded", message: "Rate limit reached, please try again" }],
  overloaded: [503, { type: "server_error", message: "The server is overloaded" }],
  model_limit: [
    429,
    {
      type: "server_is_overloaded",
      message: "Selected model is at capacity. Please try a different model.",
    },
  ],
  usage: [
    429,
    {
      type: "usage_limit_reached",
      message: "You've hit your usage limit.",
      plan_type: "plus",
      resets_at: now() + resetIn,
      resets_in_seconds: resetIn,
    },
  ],
  model_gone: [
    400,
    {
      type: "invalid_request_error",
      code: "model_not_found",
      message: "The model does not exist or you do not have access to it.",
    },
  ],
  auth: [
    401,
    {
      type: "invalid_request_error",
      code: "token_revoked",
      message: "Your authentication token has been invalidated. Please try signing in again.",
    },
  ],
  spend: [
    429,
    { type: "usage_limit_reached", message: "You have reached your monthly spend limit" },
  ],
};

function lastText(messages) {
  const last = JSON.stringify(messages?.at?.(-1) ?? "");
  return last
    .replace(/[\\"{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-80);
}

function claude(req, res, body) {
  if (req.url.startsWith("/v1/models")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5", type: "model" }], has_more: false }));
    return;
  }
  if (req.url.includes("count_tokens")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ input_tokens: 10 }));
    return;
  }
  const error = claudeErrors[modes.claude];
  if (error && refused("claude", body.model)) {
    // A rate limit or an overload is worth a retry; nothing else is, as the real API says.
    const retry = modes.claude === "rate" || modes.claude === "overloaded";
    res.writeHead(error[0], {
      "content-type": "application/json",
      "x-should-retry": String(retry),
    });
    res.end(JSON.stringify({ type: "error", error: { type: error[1], message: error[2] } }));
    return;
  }
  const model = body.model ?? "claude-opus-5-5";
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: `msg_fake_${++served}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  send("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: `Fake Claude here. You said: ${lastText(body.messages)}` },
  });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 12 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

function usageWindow(percent, seconds) {
  return {
    used_percent: percent,
    limit_window_seconds: seconds,
    reset_after_seconds: resetIn,
    reset_at: now() + resetIn,
  };
}

function chatgpt(req, res, body) {
  res.setHeader("content-type", "application/json");
  if (req.url.includes("/wham/usage")) {
    const limited = modes.chatgpt === "usage";
    res.end(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          allowed: !limited,
          limit_reached: limited,
          primary_window: usageWindow(limited ? 100 : 12, 18000),
          secondary_window: usageWindow(limited ? 100 : 30, 604800),
        },
        credits: null,
      }),
    );
    return;
  }
  // The account routing check Codex makes before a turn: one personal workspace.
  if (req.url.includes("/wham/accounts/check")) {
    res.end(
      JSON.stringify({
        accounts: [
          {
            id: "fake-chatgpt-account",
            can_access_with_session: true,
            plan_type: "plus",
            workspace_backend_origin: "NO_CONSTRAINT",
            account_routing_override: "NO_CONSTRAINT",
            structure: "personal",
          },
        ],
        account_ordering: ["fake-chatgpt-account"],
        default_account_id: "fake-chatgpt-account",
      }),
    );
    return;
  }
  if (/\/wham\/(config\/bundle|settings\/user|profiles\/me|workspace-messages)/.test(req.url)) {
    res.end("{}");
    return;
  }
  if (!req.url.includes("/responses")) {
    res.statusCode = 404;
    res.end("{}");
    return;
  }
  const error = chatgptErrors[modes.chatgpt];
  // ChatGPT refuses a model inside the stream, which Codex passes on as is.
  if (error && (modes.chatgpt === "model_limit" || modes.chatgpt === "model_gone")) {
    if (refused("chatgpt", body.model)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const id = `resp_fake_${++served}`;
      res.write(
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`,
      );
      res.write(
        `event: response.failed\ndata: ${JSON.stringify({
          type: "response.failed",
          response: {
            id,
            error: { code: error[1].code ?? error[1].type, message: error[1].message },
          },
        })}\n\n`,
      );
      res.end();
      return;
    }
  } else if (error && refused("chatgpt", body.model)) {
    res.statusCode = error[0];
    res.end(JSON.stringify({ error: error[1] }));
    return;
  }
  const id = `resp_fake_${++served}`;
  const text = `Fake ChatGPT here. You said: ${lastText(body.input)}`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  send({ type: "response.created", response: { id } });
  send({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", role: "assistant", id: `${id}_m`, content: [] },
  });
  send({
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    item_id: `${id}_m`,
    delta: text,
  });
  send({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      role: "assistant",
      id: `${id}_m`,
      content: [{ type: "output_text", text }],
    },
  });
  send({
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 12,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 22,
      },
    },
  });
  res.end();
}

/** A ChatGPT token refresh: the same unsigned tokens again. */
function refreshToken(res, body) {
  const token = body.refresh_token === "fake-chatgpt-refresh" ? fakeJwt() : null;
  res.setHeader("content-type", "application/json");
  if (!token || modes.chatgpt === "auth") {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }));
    return;
  }
  res.end(
    JSON.stringify({ id_token: token, access_token: token, refresh_token: "fake-chatgpt-refresh" }),
  );
}

function fakeJwt() {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    email: "fake-chatgpt@example.com",
    exp: now() + 365 * 24 * 3600,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "plus",
      chatgpt_account_id: "fake-chatgpt-account",
      chatgpt_user_id: "fake-chatgpt-user",
    },
  })}.fake-chatgpt`;
}

function handle(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    // Codex compresses its request bodies.
    let bytes = Buffer.concat(chunks);
    const encoding = req.headers["content-encoding"];
    try {
      if (encoding === "zstd") bytes = zstdDecompressSync(bytes);
      else if (encoding === "gzip") bytes = gunzipSync(bytes);
    } catch {}
    const raw = bytes.toString("utf8");
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {}
    if (req.url === "/control") {
      if (req.method === "POST") {
        const provider = body.provider === "chatgpt" ? "chatgpt" : "claude";
        modes[provider] = body.mode ?? "ok";
        limited[provider] = null;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(modes));
      return;
    }
    if (req.url.startsWith("/oauth/token")) {
      console.log(new Date().toISOString(), "chatgpt", modes.chatgpt, req.method, req.url);
      if (!body.refresh_token) body = Object.fromEntries(new URLSearchParams(raw));
      refreshToken(res, body);
      return;
    }
    const which = req.url.startsWith("/backend-api") ? "chatgpt" : "claude";
    // What a provider switch carried, so a walk-through can check it.
    const carried = ["<handoff_request>", "<handoff>", "<executed_actions>", "<continuation"]
      .filter((marker) =>
        raw.replaceAll("\\u003c", "<").replaceAll("\\u003e", ">").includes(marker),
      )
      .join(" ");
    console.log(
      new Date().toISOString(),
      which,
      modes[which],
      req.method,
      req.url,
      body.model ?? "",
      carried,
    );
    if (which === "chatgpt") chatgpt(req, res, body);
    else claude(req, res, body);
  });
}

http.createServer(handle).listen(port, "0.0.0.0", () => console.log(`fake providers on ${port}`));
if (tlsDir) {
  https
    .createServer(
      {
        key: readFileSync(join(tlsDir, "server.key")),
        cert: readFileSync(join(tlsDir, "server.pem")),
      },
      handle,
    )
    .listen(port + 1, "0.0.0.0", () => console.log(`fake providers (tls) on ${port + 1}`));
  https
    .createServer(
      {
        key: readFileSync(join(tlsDir, "server.key")),
        cert: readFileSync(join(tlsDir, "server.pem")),
      },
      handle,
    )
    .listen(443, "0.0.0.0", () => console.log("fake ChatGPT token refresh (tls) on 443"))
    .on("error", (error) => console.log(`no token refresh on 443: ${error.message}`));
}
