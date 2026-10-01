// PROTOTYPE ONLY: Rome credits through one shared Codex app-server.
//
// Question: can Rome's single `codex app-server` process, signed in to a
// ChatGPT account, run one conversation on a custom "Rome credits" provider
// (the amantru/rome-cloud#108 gateway) while another conversation stays on the
// ChatGPT login, and move a conversation between the two payers?
//
// Real: the Codex binary Rome pins (spawned through Rome's own AppServerClient
// with Rome's env allowlist), the ChatGPT login already on this computer, and
// #108's request admission rule (vendored in gateway-protocol.prototype.ts).
// Stubbed: the gateway's ledger and its Azure upstream. A local HTTP server
// runs #108's validateRequest on every request Codex sends, then answers with
// a canned Responses SSE stream or with #108's own error bodies.
//
// Run: pnpm prototype:rome-credits   (prints a timestamped trace to stdout)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { chmodSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AppServerClient } from "../../packages/core/src/core/codex/app-server-client.js";
import { CODEX_ENV_ALLOWLIST } from "../../packages/core/src/core/codex/common.js";
import { InferenceError, isRecord, validateRequest } from "./gateway-protocol.prototype.js";

const INSTANCE_TOKEN = `romeinst_prototype_${randomUUID().replaceAll("-", "")}`;
const MODEL = "gpt-5.6-terra";
const started = Date.now();

function trace(event: string, data: Record<string, unknown> = {}): void {
  const t = ((Date.now() - started) / 1000).toFixed(2).padStart(7);
  console.log(`${t}s ${event} ${JSON.stringify(data)}`);
}

// ---------------------------------------------------------------- gateway stub

type Planned = { kind: "text"; text: string } | { kind: "tool" } | { kind: "error"; status: 402 | 429 };
const plan: Planned[] = [];
let requestCount = 0;

function sse(res: ServerResponse, events: Record<string, unknown>[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  for (const event of events) res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function completed(id: string, output: unknown[]): Record<string, unknown>[] {
  const usage = {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 1220,
  };
  return [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    ...output.map((item, index) => ({ type: "response.output_item.done", output_index: index, item })),
    { type: "response.completed", response: { id, status: "completed", output, usage } },
  ];
}

function gatewayError(res: ServerResponse, error: InferenceError): void {
  // Same body and headers as #108's inferenceErrorResponse.
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (error.status === 429) headers["retry-after"] = "60";
  res.writeHead(error.status, headers);
  res.end(
    JSON.stringify({
      error: {
        type: error.status === 429 ? "rate_limit_error" : "gateway_error",
        code: error.code,
        message: error.message,
      },
    }),
  );
}

function decode(req: IncomingMessage, body: Buffer): unknown {
  const encoding = req.headers["content-encoding"];
  const raw = encoding === "zstd" ? zstdDecompressSync(body) : encoding === "gzip" ? gunzipSync(body) : body;
  return JSON.parse(raw.toString("utf8"));
}

function toolLabel(tool: unknown): string {
  if (!isRecord(tool)) return "?";
  const nested = Array.isArray(tool.tools) ? `[${tool.tools.map(toolLabel).join(",")}]` : "";
  return `${String(tool.type)}:${String(tool.name ?? "")}${nested}`;
}

function summarizeInput(input: unknown): Record<string, unknown> {
  if (!Array.isArray(input)) return { kind: typeof input };
  const types: Record<string, number> = {};
  let encryptedReasoning = 0;
  for (const item of input) {
    const type = isRecord(item) ? String(item.type ?? item.role ?? "?") : "?";
    types[type] = (types[type] ?? 0) + 1;
    if (isRecord(item) && item.type === "reasoning" && typeof item.encrypted_content === "string") encryptedReasoning++;
  }
  // Codex 0.156 carries tool definitions in an `additional_tools` input item,
  // not in `tools`, so #108's hosted-tool check never sees them.
  const additionalTools = input
    .filter((item) => isRecord(item) && item.type === "additional_tools")
    .map((item) => {
      const record = item as Record<string, unknown>;
      const tools = Array.isArray(record.tools) ? record.tools : [];
      return {
        keys: Object.keys(record),
        tools: tools.map(toolLabel),
      };
    });
  return { types, encryptedReasoning, additionalTools };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const n = ++requestCount;
  const auth = req.headers.authorization;
  const body = req.method === "POST" ? decode(req, Buffer.concat(chunks)) : null;
  const record: Record<string, unknown> = {
    n,
    method: req.method,
    path: req.url,
    authorization:
      auth === `Bearer ${INSTANCE_TOKEN}` ? "Bearer <instance token>" : auth ? "Bearer <OTHER credential>" : "none",
    chatgptAccountHeader: "chatgpt-account-id" in req.headers,
    contentEncoding: req.headers["content-encoding"] ?? null,
  };
  if (isRecord(body)) {
    Object.assign(record, {
      model: body.model,
      stream: body.stream,
      store: body.store,
      include: body.include,
      previous_response_id: body.previous_response_id ?? null,
      service_tier: body.service_tier ?? null,
      max_output_tokens: body.max_output_tokens ?? null,
      tools: Array.isArray(body.tools)
        ? body.tools.map((tool) => (isRecord(tool) ? `${String(tool.type)}:${String(tool.name ?? "")}` : "?"))
        : null,
      input: summarizeInput(body.input),
    });
  }
  if (auth !== `Bearer ${INSTANCE_TOKEN}`) {
    trace("gateway.request", record);
    trace("gateway.reject", { n, status: 401 });
    gatewayError(res, new InferenceError(401, "unauthorized", "Unknown instance credential."));
    return;
  }
  const operation = req.url?.endsWith("/responses/compact") ? "responses/compact" : "responses";
  try {
    validateRequest(body, operation);
    record.admission = "accepted by #108 validateRequest";
  } catch (error) {
    record.admission = `REJECTED by #108 validateRequest: ${(error as Error).message}`;
    trace("gateway.request", record);
    gatewayError(res, error as InferenceError);
    return;
  }
  trace("gateway.request", record);

  const next = plan.shift() ?? { kind: "text", text: "(unplanned gateway reply)" };
  const id = `resp_proto_${n}`;
  if (next.kind === "error") {
    const error =
      next.status === 402
        ? new InferenceError(402, "insufficient_credits", "There are not enough available credits to reserve this request.")
        : new InferenceError(429, "concurrency_limit", "This account has too many in-flight requests.");
    trace("gateway.reply", { n, status: next.status, code: error.code });
    gatewayError(res, error);
    return;
  }
  if (next.kind === "tool") {
    const tools = isRecord(body) && Array.isArray(body.tools) ? body.tools : [];
    const echo = tools.find((tool) => isRecord(tool) && String(tool.name ?? "").includes("rome_echo"));
    const name = isRecord(echo) ? String(echo.name) : "rome_echo";
    const item = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name, arguments: '{"text":"step one"}' };
    trace("gateway.reply", { n, status: 200, output: `function_call ${name}` });
    sse(res, completed(id, [item]));
    return;
  }
  const message = {
    type: "message",
    id: `msg_${n}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: next.text, annotations: [] }],
  };
  trace("gateway.reply", { n, status: 200, output: next.text });
  sse(res, completed(id, [message]));
}

// ---------------------------------------------------------------- codex side

type Waiter = { threadId: string; resolve: (value: Record<string, unknown>) => void };
const turnWaiters: Waiter[] = [];
const messages = new Map<string, string[]>();

function onNotification(method: string, params: unknown): void {
  if (!isRecord(params)) return;
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  if (method === "item/completed" && isRecord(params.item)) {
    const item = params.item;
    if (item.type === "agentMessage") {
      const list = messages.get(threadId) ?? [];
      list.push(String(item.text));
      messages.set(threadId, list);
      trace("codex.agentMessage", { thread: short(threadId), text: item.text });
    } else if (item.type !== "userMessage" && item.type !== "reasoning") {
      trace("codex.item", { thread: short(threadId), type: item.type, status: item.status ?? null });
    }
  } else if (method === "error") {
    trace("codex.error", { thread: short(threadId), willRetry: params.willRetry ?? null, error: params.error });
  } else if (method === "turn/completed" && isRecord(params.turn)) {
    const turn = params.turn;
    trace("codex.turnCompleted", { thread: short(threadId), status: turn.status, error: turn.error ?? null });
    const index = turnWaiters.findIndex((waiter) => waiter.threadId === threadId);
    if (index >= 0) turnWaiters.splice(index, 1)[0]!.resolve(turn);
  }
}

function short(threadId: string): string {
  return threadId.slice(-6);
}

const echoTool = {
  type: "function" as const,
  name: "rome_echo",
  description: "Echo text back. Prototype tool.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

async function onServerRequest(method: string, params: unknown): Promise<unknown> {
  if (method === "item/tool/call") {
    trace("codex.dynamicToolCall", { params });
    return { contentItems: [{ type: "inputText", text: "echoed: step one" }], success: true };
  }
  trace("codex.serverRequest", { method });
  return { decision: "approved" };
}

function creditsConfig(baseUrl: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_reasoning_summary: "detailed",
    hide_agent_reasoning: false,
    model_provider: "rome_credits",
    model_providers: {
      rome_credits: {
        name: "Rome credits",
        base_url: baseUrl,
        wire_api: "responses",
        requires_openai_auth: false,
        supports_websockets: false,
        experimental_bearer_token: INSTANCE_TOKEN,
        request_max_retries: 1,
        stream_max_retries: 0,
      },
    },
    ...extra,
  };
}

const ownLoginConfig = { model_reasoning_summary: "detailed", hide_agent_reasoning: false };

function threadParams(config: Record<string, unknown>): Record<string, unknown> {
  return {
    model: MODEL,
    cwd: process.cwd(),
    sandbox: "read-only",
    approvalPolicy: "never",
    baseInstructions: "You are a terse test assistant. Follow the user's instruction exactly.",
    config,
    historyMode: "paginated",
    dynamicTools: [echoTool],
  };
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      trace("gateway.crash", { error: String(error) });
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  trace("gateway.listening", { baseUrl });

  const env: Record<string, string> = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  let client!: AppServerClient;
  const startClient = async (clientEnv: Record<string, string>): Promise<void> => {
    client = new AppServerClient({
      cwd: process.cwd(),
      env: clientEnv,
      onNotification,
      onServerRequest,
      onExit: (code) => trace("codex.exit", { code }),
    });
    client.start();
    const initialized = (await client.request("initialize", {
      clientInfo: { name: "rome", title: "Rome prototype", version: "0" },
      capabilities: { experimentalApi: true },
    })) as Record<string, unknown>;
    client.notify("initialized", {});
    trace("codex.initialized", { userAgent: initialized.userAgent ?? null, envKeys: Object.keys(clientEnv) });
  };
  await startClient(env);
  try {
    const account = (await client.request("account/read", { refreshToken: false })) as Record<string, unknown>;
    const acct = isRecord(account.account) ? account.account : {};
    trace("codex.account", { type: acct.type ?? null, planType: acct.planType ?? null });
  } catch (error) {
    trace("codex.accountReadFailed", { error: (error as Error).message });
  }

  const startThread = async (label: string, config: Record<string, unknown>): Promise<string> => {
    try {
      const result = (await client.request("thread/start", threadParams(config))) as Record<string, unknown>;
      const thread = result.thread as Record<string, unknown>;
      trace("codex.threadStarted", {
        label,
        thread: short(String(thread.id)),
        modelProvider: result.modelProvider ?? thread.modelProvider ?? null,
        model: result.model ?? null,
      });
      return String(thread.id);
    } catch (error) {
      trace("codex.threadStartFailed", { label, error: (error as Error).message });
      throw error;
    }
  };

  const runTurn = async (label: string, threadId: string, text: string): Promise<Record<string, unknown>> => {
    const done = new Promise<Record<string, unknown>>((resolve) => turnWaiters.push({ threadId, resolve }));
    trace("turn.start", { label, thread: short(threadId), text });
    try {
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
    } catch (error) {
      trace("turn.startFailed", { label, error: (error as Error).message });
      return { status: "start_failed" };
    }
    const timeout = new Promise<Record<string, unknown>>((resolve) =>
      setTimeout(() => resolve({ status: "prototype_timeout_120s" }), 120_000),
    );
    const turn = await Promise.race([done, timeout]);
    trace("turn.end", { label, thread: short(threadId), status: turn.status });
    return turn;
  };

  // `modelProvider` null sends no explicit provider (config override only), to
  // show whether thread/resume honors `config.model_provider` on its own.
  const resume = async (
    label: string,
    threadId: string,
    config: Record<string, unknown>,
    modelProvider: string | null,
  ): Promise<void> => {
    await client.request("thread/unsubscribe", { threadId }).catch((error) =>
      trace("codex.unsubscribeFailed", { error: (error as Error).message }),
    );
    try {
      const { historyMode: _h, dynamicTools: _d, ...overrides } = threadParams(config);
      const params = { threadId, ...overrides, ...(modelProvider ? { modelProvider } : {}), excludeTurns: true };
      const result = (await client.request("thread/resume", params)) as Record<
        string,
        unknown
      >;
      trace("codex.threadResumed", {
        label,
        thread: short(threadId),
        requestedModelProvider: modelProvider ?? `(config only: ${String(config.model_provider ?? "none")})`,
        modelProvider: result.modelProvider ?? null,
      });
    } catch (error) {
      trace("codex.threadResumeFailed", { label, error: (error as Error).message });
    }
  };

  const section = (title: string) => {
    plan.length = 0;
    console.log(`\n=== ${title}`);
  };
  const history = async (label: string, threadId: string) => {
    const turns = (await client.request("thread/turns/list", { threadId, limit: 5 }).catch((error) => ({
      error: (error as Error).message,
    }))) as Record<string, unknown>;
    trace(`check.${label}.history`, {
      turns: Array.isArray(turns.data)
        ? (turns.data as Record<string, unknown>[]).map((turn) => ({
            status: turn.status,
            items: Array.isArray(turn.items)
              ? (turn.items as Record<string, unknown>[]).map((item) => item.type)
              : null,
          }))
        : turns,
    });
  };

  // Q1 + Q2: Rome's thread config unchanged except for the provider. Does the
  // request Codex sends pass #108's admission rule as is?
  section("S1 credits thread with Rome's current config (Codex defaults for web search)");
  plan.push({ kind: "text", text: "BRAVO" });
  const probe = await startThread("credits-default-config", creditsConfig(baseUrl));
  await runTurn("credits-default-config", probe, "Reply with exactly: BRAVO");

  // Q1: one process, two payers, concurrently.
  section("S2 concurrent: ChatGPT thread A and credits thread B in one app-server");
  const a = await startThread("A own-login", ownLoginConfig);
  const b = await startThread("B credits", creditsConfig(baseUrl, { web_search: "disabled" }));
  plan.push({ kind: "text", text: "BRAVO" });
  const before = requestCount;
  await Promise.all([
    runTurn("A own-login", a, "Reply with exactly: ALPHA"),
    runTurn("B credits", b, "Reply with exactly: BRAVO"),
  ]);
  trace("check.S2", {
    gatewayRequestsDuringS2: requestCount - before,
    aMessages: messages.get(a) ?? [],
    bMessages: messages.get(b) ?? [],
  });

  // Q3: credits -> own login (spec D10). Rome's resume path: unsubscribe, then
  // thread/resume with the new config overrides.
  section("S3 move credits thread B to the ChatGPT login");
  await resume("B -> own-login (config only)", b, ownLoginConfig, null);
  await resume("B -> own-login (explicit modelProvider)", b, ownLoginConfig, "openai");
  const beforeS3 = requestCount;
  await runTurn("B on own-login", b, "Reply with exactly: CHARLIE");
  trace("check.S3", { gatewayRequestsDuringS3: requestCount - beforeS3, bMessages: messages.get(b) ?? [] });

  // Q3 reverse: own login -> credits (spec: credits pick up when the login is
  // limited). What history, including OpenAI-encrypted reasoning, does Codex
  // replay to the gateway?
  section("S4 move ChatGPT thread A to Rome credits");
  await resume("A -> credits (config only)", a, creditsConfig(baseUrl, { web_search: "disabled" }), null);
  await resume("A -> credits (explicit modelProvider)", a, creditsConfig(baseUrl, { web_search: "disabled" }), "rome_credits");
  plan.push({ kind: "text", text: "DELTA" });
  await runTurn("A on credits", a, "Reply with exactly: DELTA");
  await history("S4", a);

  section("S4b move credits thread B back to Rome credits after its own-login turn");
  await resume("B -> credits", b, creditsConfig(baseUrl, { web_search: "disabled" }), "rome_credits");
  plan.push({ kind: "text", text: "GOLF" });
  await runTurn("B back on credits", b, "Reply with exactly: GOLF");

  // Q4: credits refused before a turn, and in the middle of a turn.
  section("S5 credits refused (402) before the first model step");
  const c = await startThread("C credits", creditsConfig(baseUrl, { web_search: "disabled" }));
  plan.push({ kind: "error", status: 402 });
  await runTurn("C refused", c, "Reply with exactly: ECHO");

  section("S6 credits run out mid-turn: tool call, then 402 on the next model step");
  const d = await startThread("D credits", creditsConfig(baseUrl, { web_search: "disabled" }));
  plan.push({ kind: "tool" }, { kind: "error", status: 402 });
  await runTurn("D mid-turn", d, "Call rome_echo with text 'step one', then summarize.");
  await history("S6", d);

  section("S7 gateway concurrency limit (429 with retry-after: 60)");
  const e = await startThread("E credits", creditsConfig(baseUrl, { web_search: "disabled" }));
  plan.push({ kind: "error", status: 429 }, { kind: "error", status: 429 }, { kind: "error", status: 429 });
  await runTurn("E 429", e, "Reply with exactly: FOXTROT");
  await history("S7", e);

  // Q3 again, with the credits provider defined for the whole app-server
  // process (`-c` at spawn, token from the process env) instead of per thread.
  section("S8 restart app-server with the credits provider defined process-wide");
  client.close();
  const shim = createRequire(join(process.cwd(), "packages/core/package.json")).resolve("@openai/codex/bin/codex.js");
  const provider = [
    `name="Rome credits"`,
    `base_url="${baseUrl}"`,
    `env_key="ROME_CREDITS_TOKEN"`,
    `wire_api="responses"`,
    `requires_openai_auth=false`,
    `supports_websockets=false`,
    `request_max_retries=1`,
    `stream_max_retries=0`,
  ].join(",");
  const wrapper = join(tmpdir(), "rome-credits-prototype-codex.sh");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${shim}" -c 'model_providers.rome_credits={${provider}}' -c 'web_search="disabled"' "$@"\n`,
  );
  chmodSync(wrapper, 0o700);
  process.env.ROME_CODEX_BIN = wrapper;
  await startClient({ ...env, ROME_CREDITS_TOKEN: INSTANCE_TOKEN });
  const globalCredits = { ...ownLoginConfig, model_provider: "rome_credits" };

  const p = await startThread("P credits (process-wide provider)", globalCredits);
  plan.push({ kind: "text", text: "HOTEL" });
  await runTurn("P on credits", p, "Reply with exactly: HOTEL");
  await resume("P -> own-login", p, ownLoginConfig, "openai");
  const beforeP = requestCount;
  await runTurn("P on own-login", p, "Reply with exactly: INDIA");
  trace("check.S8.ownLogin", { gatewayRequests: requestCount - beforeP });
  await resume("P -> credits", p, globalCredits, "rome_credits");
  plan.push({ kind: "text", text: "JULIET" });
  await runTurn("P back on credits", p, "Reply with exactly: JULIET");
  await history("S8.P", p);

  const q = await startThread("Q own-login", ownLoginConfig);
  await runTurn("Q on own-login", q, "Reply with exactly: KILO");
  await resume("Q -> credits", q, globalCredits, "rome_credits");
  plan.push({ kind: "text", text: "LIMA" });
  await runTurn("Q on credits", q, "Reply with exactly: LIMA");

  trace("done", { gatewayRequests: requestCount });
  client.close();
  server.close();
}

main().catch((error) => {
  trace("prototype.failed", { error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
