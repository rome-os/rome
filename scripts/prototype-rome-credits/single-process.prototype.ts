// PROTOTYPE ONLY: can Rome keep ONE shared `codex app-server` and still run
// Rome credits next to the guardian's own OpenAI login?
//
// Design under test: the process default stays the built-in `openai` provider
// (the guardian's own login). A `rome_credits` provider is defined once for the
// whole process, reading the instance token from the process env. Rome picks
// the payer per conversation with the explicit `modelProvider` param on EVERY
// thread/start and thread/resume, and switches payer by unsubscribing and
// resuming with the other provider.
//
// Real: the Codex binary Rome pins, spawned through Rome's AppServerClient,
// Codex's own login (API-key mode) and provider routing, #108's validateRequest.
// Stubbed: both upstreams. `openai_base_url` points the built-in `openai`
// provider at /own on a local stub, and `rome_credits` at /credits. The run
// uses a throwaway HOME, so nothing touches the real ~/.codex.
//
// Run: pnpm prototype:rome-credits:single

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { AppServerClient } from "../../packages/core/src/core/codex/app-server-client.js";
import { CODEX_ENV_ALLOWLIST } from "../../packages/core/src/core/codex/common.js";
import { InferenceError, isRecord, validateRequest } from "./gateway-protocol.prototype.js";

const INSTANCE_TOKEN = `romeinst_prototype_${randomUUID().replaceAll("-", "")}`;
const OWN_API_KEY = `sk-prototype-own-${randomUUID().replaceAll("-", "")}`;
const MODEL = "gpt-5.6-terra";
const started = Date.now();

function trace(event: string, data: Record<string, unknown> = {}): void {
  const t = ((Date.now() - started) / 1000).toFixed(2).padStart(7);
  console.log(`${t}s ${event} ${JSON.stringify(data)}`);
}

// ------------------------------------------------------------------- stub

type Payer = "own" | "credits";
type Planned = { kind: "text"; text: string } | { kind: "error"; status: 402 | 429 };
const plans: Record<Payer, Planned[]> = { own: [], credits: [] };
const counts: Record<Payer, number> = { own: 0, credits: 0 };

function writeError(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function messageCount(input: unknown): number {
  return Array.isArray(input) ? input.filter((item) => isRecord(item) && item.type === "message").length : 0;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const payer: Payer | null = req.url?.startsWith("/own/") ? "own" : req.url?.startsWith("/credits/") ? "credits" : null;
  if (!payer || req.method !== "POST" || !req.url?.endsWith("/responses")) {
    // Codex probes the built-in provider with a websocket GET first, then
    // falls back to HTTP; answer everything but POST /responses with 404.
    if (req.method !== "GET") trace("stub.unexpected", { method: req.method, url: req.url });
    writeError(res, 404, { error: { message: "not found" } });
    return;
  }
  const raw = Buffer.concat(chunks);
  const encoding = req.headers["content-encoding"];
  const body: unknown = JSON.parse(
    (encoding === "zstd" ? zstdDecompressSync(raw) : encoding === "gzip" ? gunzipSync(raw) : raw).toString("utf8"),
  );
  const n = ++counts[payer];
  const auth = req.headers.authorization;
  const expected = payer === "own" ? `Bearer ${OWN_API_KEY}` : `Bearer ${INSTANCE_TOKEN}`;
  const record: Record<string, unknown> = {
    payer,
    n,
    authorization:
      auth === expected
        ? payer === "own"
          ? "Bearer <own API key>"
          : "Bearer <instance token>"
        : auth
          ? "Bearer <WRONG credential>"
          : "none",
    inputMessages: isRecord(body) ? messageCount(body.input) : null,
  };
  if (payer === "credits") {
    try {
      validateRequest(body, "responses");
      record.admission = "accepted by #108";
    } catch (error) {
      record.admission = `REJECTED by #108: ${(error as Error).message}`;
      trace("stub.request", record);
      writeError(res, 400, { error: { code: (error as InferenceError).code, message: (error as Error).message } });
      return;
    }
  }
  trace("stub.request", record);
  const next = plans[payer].shift() ?? { kind: "text", text: `${payer.toUpperCase()}-OK` };
  if (next.kind === "error") {
    if (payer === "own") {
      // What OpenAI returns when an API key is out of quota.
      writeError(res, 429, {
        error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota." },
      });
    } else {
      writeError(res, 402, {
        error: { type: "gateway_error", code: "insufficient_credits", message: "Not enough credits." },
      });
    }
    trace("stub.reply", { payer, n, status: next.kind === "error" ? (payer === "own" ? 429 : 402) : 200 });
    return;
  }
  const id = `resp_${payer}_${n}`;
  const message = {
    type: "message",
    id: `msg_${payer}_${n}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: next.text, annotations: [] }],
  };
  const usage = {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 105,
  };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  for (const event of [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id, status: "completed", output: [message], usage } },
  ]) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
  trace("stub.reply", { payer, n, status: 200, text: next.text });
}

// ------------------------------------------------------------------ codex

type Waiter = { threadId: string; resolve: (turn: Record<string, unknown>) => void };
const waiters: Waiter[] = [];

function short(threadId: string): string {
  return threadId.slice(-6);
}

function onNotification(method: string, params: unknown): void {
  if (!isRecord(params)) return;
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  if (method === "thread/status/changed") {
    trace("codex.status", { thread: short(threadId), status: params.status });
  } else if (method === "thread/closed") {
    trace("codex.closed", { thread: short(threadId) });
  } else if (method === "item/completed" && isRecord(params.item) && params.item.type === "agentMessage") {
    trace("codex.agentMessage", { thread: short(threadId), text: params.item.text });
  } else if (method === "error" && isRecord(params.error)) {
    trace("codex.error", { thread: short(threadId), willRetry: params.willRetry, message: params.error.message });
  } else if (method === "turn/completed" && isRecord(params.turn)) {
    const index = waiters.findIndex((waiter) => waiter.threadId === threadId);
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(params.turn);
  }
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      trace("stub.crash", { error: String(error) });
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const home = mkdtempSync(join(tmpdir(), "rome-credits-single-"));
  const workdir = join(home, "work");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(workdir);
  trace("setup", { home: "<mkdtemp>", origin });

  const writeConfig = (unloadDelaySecs: number | null) => {
    // Production would pass the same keys as `-c` flags at spawn; a config
    // file keeps the throwaway HOME self-contained. `openai_base_url` exists
    // only so the own-login path reaches the stub.
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        `openai_base_url = "${origin}/own/v1"`,
        unloadDelaySecs === null ? "" : `thread_unload_delay_secs = ${unloadDelaySecs}`,
        `[model_providers.rome_credits]`,
        `name = "Rome credits"`,
        `base_url = "${origin}/credits/v1"`,
        `env_key = "ROME_CREDITS_TOKEN"`,
        `wire_api = "responses"`,
        `requires_openai_auth = false`,
        `supports_websockets = false`,
        `request_max_retries = 0`,
        `stream_max_retries = 0`,
        "",
      ].join("\n"),
    );
    trace("config", { thread_unload_delay_secs: unloadDelaySecs ?? "default (60)" });
  };

  const env: Record<string, string> = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.HOME = home;
  env.ROME_CREDITS_TOKEN = INSTANCE_TOKEN;

  let client!: AppServerClient;
  const startProcess = async (label: string) => {
    client = new AppServerClient({
      cwd: workdir,
      env,
      onNotification,
      onServerRequest: async (method) => {
        trace("codex.serverRequest", { method });
        return { decision: "approved" };
      },
      onExit: (code) => trace("codex.exit", { code }),
    });
    client.start();
    const init = (await client.request("initialize", {
      clientInfo: { name: "rome", title: "Rome prototype", version: "0" },
      capabilities: { experimentalApi: true },
    })) as Record<string, unknown>;
    client.notify("initialized", {});
    trace("process.started", { label, userAgent: init.userAgent });
  };

  // Rome's own thread overrides (codex-app-server-provider.ts), minus the
  // dynamic tool catalog and MCP servers, plus an explicit provider.
  const overrides = (modelProvider: string | null) => ({
    model: MODEL,
    ...(modelProvider ? { modelProvider } : {}),
    cwd: workdir,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    baseInstructions: "You are a terse test assistant. Follow the user's instruction exactly.",
    config: { model_reasoning_summary: "detailed", hide_agent_reasoning: false },
  });

  const start = async (label: string, modelProvider: string | null): Promise<string> => {
    const result = (await client.request("thread/start", {
      ...overrides(modelProvider),
      historyMode: "paginated",
    })) as Record<string, unknown>;
    const threadId = String((result.thread as Record<string, unknown>).id);
    trace("thread.started", { label, thread: short(threadId), requested: modelProvider, modelProvider: result.modelProvider });
    return threadId;
  };

  // A thread that is unloading answers "is closing; retry", so retry briefly.
  const resume = async (label: string, threadId: string, modelProvider: string | null): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await resumeOnce(label, threadId, modelProvider);
      } catch (error) {
        const message = (error as Error).message;
        if (!message.includes("is closing") || attempt >= 20) {
          trace("thread.resumeFailed", { label, thread: short(threadId), error: message });
          return null;
        }
        trace("thread.resumeRetry", { label, thread: short(threadId), attempt });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };

  const resumeOnce = async (label: string, threadId: string, modelProvider: string | null): Promise<unknown> => {
    {
      const result = (await client.request("thread/resume", {
        threadId,
        ...overrides(modelProvider),
        excludeTurns: true,
      })) as Record<string, unknown>;
      trace("thread.resumed", { label, thread: short(threadId), requested: modelProvider, modelProvider: result.modelProvider });
      return result.modelProvider;
    }
  };

  const unsubscribe = async (threadId: string) => {
    const result = await client.request("thread/unsubscribe", { threadId }).catch((error) => ({
      error: (error as Error).message,
    }));
    trace("thread.unsubscribed", { thread: short(threadId), result });
  };

  const turn = async (label: string, threadId: string, text: string): Promise<string> => {
    let timer: NodeJS.Timeout | undefined;
    let waiter: Waiter | undefined;
    const done = new Promise<Record<string, unknown>>((resolve) => {
      waiter = { threadId, resolve };
      waiters.push(waiter);
    });
    const before = { ...counts };
    trace("turn.start", { label, thread: short(threadId), text });
    await client.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
    const timeout = new Promise<Record<string, unknown>>((resolve) => {
      timer = setTimeout(() => resolve({ status: "prototype_timeout" }), 90_000);
    });
    const result = await Promise.race([done, timeout]);
    clearTimeout(timer);
    const index = waiters.indexOf(waiter!);
    if (index >= 0) waiters.splice(index, 1);
    const paidBy = counts.own > before.own ? "own" : counts.credits > before.credits ? "credits" : "none";
    trace("turn.end", { label, thread: short(threadId), status: result.status, paidBy });
    return paidBy;
  };

  const results: Array<{ check: string; pass: boolean; detail: string }> = [];
  const check = (name: string, pass: boolean, detail: string) => {
    results.push({ check: name, pass, detail });
    trace(pass ? "CHECK.pass" : "CHECK.FAIL", { check: name, detail });
  };
  const section = (title: string) => {
    plans.own.length = 0;
    plans.credits.length = 0;
    console.log(`\n=== ${title}`);
  };

  // -------------------------------------------------------------- run 1
  writeConfig(null);
  await startProcess("process 1 (default unload delay)");
  const login = await client.request("account/login/start", { type: "apiKey", apiKey: OWN_API_KEY });
  trace("codex.login", { result: login });

  section("C1 start a conversation on credits in the shared process");
  const x = await start("X", "rome_credits");
  check("C1 credits on start", (await turn("X", x, "Reply: one")) === "credits", "thread/start modelProvider=rome_credits");

  section("C2 an own-login and a credits conversation run at the same time");
  const y = await start("Y", null);
  const [paidX, paidY] = await Promise.all([turn("X", x, "Reply: two"), turn("Y", y, "Reply: two")]);
  check("C2 concurrent payers", paidX === "credits" && paidY === "own", `X=${paidX} Y=${paidY}`);

  section("C3 credits -> own login after the guardian connects ChatGPT (spec D10)");
  await unsubscribe(x);
  const c3 = await resume("X -> own", x, "openai");
  const paidC3 = await turn("X", x, "Reply: three");
  check("C3 switch credits -> own on an idle thread", c3 === "openai" && paidC3 === "own", `resumed=${String(c3)} paid=${paidC3}`);

  section("C4 own login hits its limit mid-conversation, then credits pick up (spec D3)");
  plans.own.push({ kind: "error", status: 429 });
  const failed = await turn("Y", y, "Reply: four");
  await unsubscribe(y);
  const immediate = await resume("Y -> credits right after the failure", y, "rome_credits");
  check(
    "C4a immediate switch after a failed turn",
    immediate === "rome_credits",
    `failed turn paid=${failed}; resumed=${String(immediate)} (Codex keeps a loaded thread in SystemError and ignores resume overrides)`,
  );
  // Each resume re-subscribes and restarts the unload timer, so unsubscribe
  // once and wait past the default 60 s delay before the next resume.
  let switched = immediate === "rome_credits";
  const waitStarted = Date.now();
  if (!switched) {
    await unsubscribe(y);
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    switched = (await resume("Y -> credits after the unload delay", y, "rome_credits")) === "rome_credits";
  }
  const waited = ((Date.now() - waitStarted) / 1000).toFixed(0);
  const paidC4 = switched ? await turn("Y", y, "Reply: four again") : "skipped";
  check("C4b switch after the thread unloads", switched && paidC4 === "credits", `waited ~${waited}s, paid=${paidC4}`);

  section("C5 a credits conversation before a Rome restart");
  const z = await start("Z", "rome_credits");
  await turn("Z", z, "Reply: five");
  client.close();

  // -------------------------------------------------------------- run 2
  section("C6 after restart: Rome's current resume (no modelProvider) vs explicit modelProvider");
  writeConfig(0);
  await startProcess("process 2 (thread_unload_delay_secs = 0)");
  const implicit = await resume("Z as Rome resumes today", z, null);
  check("C6a restart without explicit provider", implicit === "rome_credits", `resumed=${String(implicit)}`);
  await unsubscribe(z);
  const explicit = await resume("Z with explicit provider", z, "rome_credits");
  const paidC6 = await turn("Z", z, "Reply: six");
  check("C6b restart with explicit provider", explicit === "rome_credits" && paidC6 === "credits", `resumed=${String(explicit)} paid=${paidC6}`);

  section("C7 with thread_unload_delay_secs = 0: switch right after an own-login failure");
  const w = await start("W", null);
  plans.own.push({ kind: "error", status: 429 });
  await turn("W", w, "Reply: seven");
  await unsubscribe(w);
  let c7: unknown = null;
  for (let attempt = 1; attempt <= 5 && c7 !== "rome_credits"; attempt++) {
    c7 = await resume(`W -> credits attempt ${attempt}`, w, "rome_credits");
    if (c7 !== "rome_credits") {
      await unsubscribe(w);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const paidC7 = c7 === "rome_credits" ? await turn("W", w, "Reply: seven again") : "skipped";
  check("C7 immediate switch with zero unload delay", c7 === "rome_credits" && paidC7 === "credits", `resumed=${String(c7)} paid=${paidC7}`);

  section("C8 credits -> own -> credits on one conversation keeps its history");
  await unsubscribe(z);
  await resume("Z -> own", z, "openai");
  const paidOwn = await turn("Z", z, "Reply: eight");
  await unsubscribe(z);
  await resume("Z -> credits", z, "rome_credits");
  const paidBack = await turn("Z", z, "Reply: eight again");
  check("C8 round trip", paidOwn === "own" && paidBack === "credits", `own=${paidOwn} back=${paidBack}`);
  client.close();

  // ----------------------------------------------------------- evidence
  const leaked: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (statSync(path).size < 50_000_000 && readFileSync(path).includes(INSTANCE_TOKEN)) leaked.push(path.replace(home, "~"));
    }
  };
  walk(home);
  check("token never written to disk", leaked.length === 0, leaked.length ? leaked.join(", ") : "no file under the Codex home contains the instance token");

  console.log("\n=== summary");
  for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.check}  (${result.detail})`);
  server.close();
  if (!process.env.KEEP_PROTOTYPE_HOME) rmSync(home, { recursive: true, force: true });
  trace("done", { ownRequests: counts.own, creditsRequests: counts.credits });
}

main().catch((error) => {
  trace("prototype.failed", { error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
