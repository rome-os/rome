import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { AgentMessage } from "../../types.js";
import {
  createPiModelRuntime,
  discoverPiModels,
  qualifyPiModelId,
  runPiPrototypeTurn,
} from "./pi-sdk-prototype.js";

const ROUTE = "/prototype/pi-provider";
const BODY_LIMIT_BYTES = 32 * 1024;
const DEMO_MODELS = [
  { provider: "prototype-anthropic", id: "shared/model", name: "Demo Claude route" },
  { provider: "prototype-openai", id: "shared/model", name: "Demo GPT route" },
] as const;

type PrototypeMode = "demo" | "live";

interface TurnRequest {
  mode: PrototypeMode;
  qualifiedModelId: string;
  prompt: string;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function safeLiveError(operation: "discovery" | "turn"): string {
  return operation === "discovery"
    ? "Pi discovery failed. Configure Pi in your own terminal, then refresh this prototype."
    : "The Pi turn failed. Verify the selected model and Pi credentials in your own terminal, then retry.";
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseTurnRequest(value: unknown): TurnRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid turn request");
  const candidate = value as Partial<TurnRequest>;
  if (candidate.mode !== "demo" && candidate.mode !== "live") {
    throw new Error("Invalid prototype mode");
  }
  if (typeof candidate.qualifiedModelId !== "string" || !candidate.qualifiedModelId) {
    throw new Error("Choose a Pi model first");
  }
  if (typeof candidate.prompt !== "string" || !candidate.prompt.trim()) {
    throw new Error("Enter a message first");
  }
  return {
    mode: candidate.mode,
    qualifiedModelId: candidate.qualifiedModelId,
    prompt: candidate.prompt.trim().slice(0, 8_000),
  };
}

async function discoverDemoModels() {
  const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-ui-demo-"));
  try {
    const providers = Object.fromEntries(
      DEMO_MODELS.map((model) => [
        model.provider,
        {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "local-demo-placeholder",
          models: [{ id: model.id, name: model.name }],
        },
      ]),
    );
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers }));
    const runtime = await createPiModelRuntime({ agentDir });
    return await discoverPiModels(runtime);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

function demoTurnMessages(request: TurnRequest): AgentMessage[] {
  const knownModels = new Set(
    DEMO_MODELS.map((model) => qualifyPiModelId(model.provider, model.id)),
  );
  if (!knownModels.has(request.qualifiedModelId)) {
    throw new Error("The selected demo model is no longer available; refresh discovery");
  }
  const content = `Demo response from ${request.qualifiedModelId}: I received “${request.prompt}”. This local turn used no credential or provider network.`;
  const accounting = {
    provider: "pi",
    model: request.qualifiedModelId,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    stopReason: "stop",
  };
  return [
    { type: "text_delta", content: content.slice(0, 34) },
    { type: "text_delta", content: content.slice(34) },
    { type: "text", content, turnPhase: "final" },
    { type: "result", content, accounting },
  ];
}

function writeMessage(response: ServerResponse, message: AgentMessage): void {
  response.write(`${JSON.stringify(message)}\n`);
}

async function handleDiscovery(response: ServerResponse, mode: PrototypeMode): Promise<void> {
  try {
    const discovery =
      mode === "demo"
        ? await discoverDemoModels()
        : await discoverPiModels(await createPiModelRuntime());
    sendJson(response, 200, {
      mode,
      ...discovery,
      guidance:
        mode === "demo"
          ? "Deterministic local catalog; no credential or provider network is used."
          : discovery.models.length
            ? "Models discovered from the local Pi configuration."
            : "No authenticated Pi models were found. Configure Pi in your own terminal, then refresh.",
    });
  } catch {
    sendJson(response, 503, { error: safeLiveError("discovery") });
  }
}

async function handleTurn(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let turn: TurnRequest;
  try {
    turn = parseTurnRequest(await readJsonBody(request));
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/x-ndjson; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  if (turn.mode === "demo") {
    try {
      for (const message of demoTurnMessages(turn)) writeMessage(response, message);
    } catch (error) {
      writeMessage(response, {
        type: "error",
        error: error instanceof Error ? error.message : "Demo turn failed",
      });
    }
    response.end();
    return;
  }

  const controller = new AbortController();
  response.once("close", () => controller.abort());
  try {
    const runtime = await createPiModelRuntime();
    await runPiPrototypeTurn({
      runtime,
      qualifiedModelId: turn.qualifiedModelId,
      prompt: turn.prompt,
      signal: controller.signal,
      emit(message) {
        writeMessage(
          response,
          message.type === "error" ? { ...message, error: safeLiveError("turn") } : message,
        );
      },
    });
  } catch {
    writeMessage(response, { type: "error", error: safeLiveError("turn") });
  } finally {
    response.end();
  }
}

const page = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rome · Pi Provider Prototype</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0b0d12; color: #f4f5f7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 10% 0%, #252044 0, transparent 34rem), #0b0d12; }
    button, select, textarea { font: inherit; }
    .shell { width: min(1100px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    .brand { display: flex; gap: 12px; align-items: center; font-weight: 760; letter-spacing: -.02em; }
    .mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(145deg, #9886ff, #6250d8); box-shadow: 0 8px 24px #6b57dc55; }
    .badge { border: 1px solid #8978ef66; background: #7763e622; color: #cfc7ff; padding: 6px 9px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: .08em; }
    .grid { display: grid; grid-template-columns: 330px minmax(0, 1fr); gap: 18px; }
    .card { border: 1px solid #ffffff14; background: #11141bcc; border-radius: 16px; box-shadow: 0 18px 60px #0006; overflow: hidden; }
    .panel { padding: 20px; }
    h1 { font-size: 24px; margin: 0 0 8px; letter-spacing: -.03em; }
    h2 { font-size: 14px; margin: 0 0 12px; color: #dfe2e8; }
    p { color: #9ca3b1; font-size: 13px; line-height: 1.55; }
    .mode { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; background: #080a0f; padding: 5px; border-radius: 11px; margin: 20px 0; }
    .mode button { border: 0; color: #969dac; background: transparent; padding: 9px; border-radius: 8px; cursor: pointer; }
    .mode button.active { color: white; background: #29243e; box-shadow: inset 0 0 0 1px #9b8bff44; }
    label { display: block; font-size: 12px; color: #aeb4c0; margin: 16px 0 7px; }
    select, textarea { width: 100%; color: #f7f7fa; border: 1px solid #ffffff18; background: #090b10; border-radius: 10px; padding: 11px 12px; outline: none; }
    select:focus, textarea:focus { border-color: #8b78ef; box-shadow: 0 0 0 3px #7865e522; }
    .primary { width: 100%; border: 0; border-radius: 10px; color: white; background: #6f5bd7; padding: 11px 14px; margin-top: 12px; cursor: pointer; font-weight: 700; }
    .primary:hover { background: #7c68e4; }
    .primary:disabled { opacity: .45; cursor: not-allowed; }
    .status { margin-top: 12px; padding: 10px 11px; border-radius: 10px; font-size: 12px; line-height: 1.45; background: #0a0d12; color: #9ea6b5; border: 1px solid #ffffff0d; }
    .status.good { color: #a9e8c6; border-color: #5ac38a35; }
    .status.bad { color: #ffb5b5; border-color: #fa77773d; }
    .chat { min-height: 620px; display: flex; flex-direction: column; }
    .chat-head { padding: 16px 20px; border-bottom: 1px solid #ffffff10; display: flex; justify-content: space-between; align-items: center; }
    .chat-head small { color: #858d9d; }
    #messages { flex: 1; padding: 22px; overflow: auto; display: flex; flex-direction: column; gap: 14px; }
    .empty { margin: auto; max-width: 390px; text-align: center; color: #8d94a2; }
    .bubble { max-width: 82%; border-radius: 14px; padding: 11px 14px; white-space: pre-wrap; line-height: 1.5; font-size: 14px; }
    .user { align-self: flex-end; background: #6e5bd0; }
    .assistant { align-self: flex-start; background: #1d212b; border: 1px solid #ffffff0c; }
    .event { align-self: flex-start; color: #939aa8; font-size: 11px; padding-left: 5px; }
    form { border-top: 1px solid #ffffff10; padding: 16px; display: grid; grid-template-columns: 1fr auto; gap: 10px; }
    textarea { min-height: 48px; max-height: 140px; resize: vertical; }
    form .primary { width: auto; min-width: 90px; margin: 0; }
    .footnote { margin-top: 14px; font-size: 11px; color: #757d8b; }
    @media (max-width: 780px) { .grid { grid-template-columns: 1fr; } .chat { min-height: 560px; } }
  </style>
</head>
<body>
  <div class="shell">
    <header><div class="brand"><div class="mark">R</div><span>Rome</span><span style="color:#707887">/</span><span>Pi Coding Agent</span></div><span class="badge">PROTOTYPE · LOCAL ONLY</span></header>
    <div class="grid">
      <aside class="card panel">
        <h1>Pi provider</h1>
        <p>Discover an exact Pi upstream provider/model pair, choose it explicitly, and attempt one Rome-style conversation turn.</p>
        <div class="mode"><button id="demoMode" class="active" type="button">Demo mode</button><button id="liveMode" type="button">Local Pi</button></div>
        <div id="modeHelp" class="status">Deterministic inspection mode. No credentials, provider network, or real model are used.</div>
        <label for="model">Qualified Pi model</label>
        <select id="model" disabled><option>Discovering…</option></select>
        <button id="refresh" class="primary" type="button">Refresh discovery</button>
        <div id="discovery" class="status">Starting local discovery…</div>
        <p class="footnote">Live setup stays Pi-owned. Configure Pi in your own terminal, then return here and refresh. This page never launches Pi CLI, a shell, or a PTY.</p>
      </aside>
      <main class="card chat">
        <div class="chat-head"><div><strong>Prototype conversation</strong><br><small id="selected">No model selected</small></div><small>Rome transcript preview</small></div>
        <div id="messages"><div class="empty"><strong>UI-facing vertical slice</strong><p>Choose a discovered model and send a message. Demo mode returns a deterministic local stream; Local Pi attempts the real SDK turn.</p></div></div>
        <form id="composer"><textarea id="prompt" placeholder="Send a message through the selected Pi model…"></textarea><button id="send" class="primary" disabled>Send</button></form>
      </main>
    </div>
  </div>
  <script>
    const base = ${JSON.stringify(ROUTE)};
    let mode = "demo";
    let sending = false;
    const elements = Object.fromEntries(["demoMode","liveMode","modeHelp","model","refresh","discovery","selected","messages","composer","prompt","send"].map(id => [id, document.getElementById(id)]));
    function setStatus(text, kind = "") { elements.discovery.textContent = text; elements.discovery.className = "status " + kind; }
    function syncSelection() { const option = elements.model.selectedOptions[0]; elements.selected.textContent = option?.dataset.label || "No model selected"; elements.send.disabled = sending || !elements.model.value; }
    function addMessage(kind, text) { const node = document.createElement("div"); node.className = kind === "event" ? "event" : "bubble " + kind; node.textContent = text; if (elements.messages.querySelector(".empty")) elements.messages.replaceChildren(); elements.messages.append(node); elements.messages.scrollTop = elements.messages.scrollHeight; return node; }
    async function discover() {
      elements.model.disabled = true; elements.refresh.disabled = true; elements.send.disabled = true; setStatus("Discovering " + (mode === "demo" ? "demo catalog…" : "local Pi configuration…"));
      try {
        const response = await fetch(base + "/api/models?mode=" + mode, { cache: "no-store" });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || "Discovery failed");
        elements.model.replaceChildren();
        for (const item of data.models) { const option = document.createElement("option"); option.value = item.qualifiedModelId; option.textContent = item.upstreamProvider + " / " + item.modelId; option.dataset.label = "Pi · " + option.textContent; elements.model.append(option); }
        const caveat = data.eligibilityCaveat ? " Prototype caveat: " + data.eligibilityCaveat : "";
        if (!data.models.length) { const option = document.createElement("option"); option.textContent = "No authenticated Pi models"; option.value = ""; elements.model.append(option); setStatus(data.guidance + caveat, "bad"); }
        else setStatus(data.models.length + " model" + (data.models.length === 1 ? "" : "s") + " discovered. " + data.guidance + caveat, "good");
        elements.model.disabled = !data.models.length; syncSelection();
      } catch (error) { elements.model.replaceChildren(new Option("Discovery unavailable", "")); setStatus(error.message, "bad"); syncSelection(); }
      finally { elements.refresh.disabled = false; }
    }
    function chooseMode(next) { mode = next; elements.demoMode.classList.toggle("active", mode === "demo"); elements.liveMode.classList.toggle("active", mode === "live"); elements.modeHelp.textContent = mode === "demo" ? "Deterministic inspection mode. No credentials, provider network, or real model are used." : "Authenticated mode reads Pi-owned local configuration. Raw credentials and SDK errors are never returned to this page."; discover(); }
    elements.demoMode.addEventListener("click", () => chooseMode("demo")); elements.liveMode.addEventListener("click", () => chooseMode("live")); elements.refresh.addEventListener("click", discover); elements.model.addEventListener("change", syncSelection);
    elements.composer.addEventListener("submit", async event => {
      event.preventDefault(); const prompt = elements.prompt.value.trim(); if (!prompt || !elements.model.value || sending) return;
      sending = true; syncSelection(); addMessage("user", prompt); elements.prompt.value = ""; const assistant = addMessage("assistant", ""); let preview = "";
      try {
        const response = await fetch(base + "/api/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, qualifiedModelId: elements.model.value, prompt }) });
        if (!response.ok || !response.body) { const data = await response.json(); throw new Error(data.error || "Turn failed"); }
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let pending = "";
        while (true) { const { value, done } = await reader.read(); pending += value || ""; const lines = pending.split("\n"); pending = lines.pop(); for (const line of lines) { if (!line) continue; const message = JSON.parse(line); if (message.type === "text_delta") { preview += message.content; assistant.textContent = preview; } else if (message.type === "text" || message.type === "result") { preview = message.content; assistant.textContent = preview; } else if (message.type === "thinking") addMessage("event", "Thinking block received"); else if (message.type === "tool_use") addMessage("event", "Rome tool: " + message.tool); else if (message.type === "error") throw new Error(message.error); } if (done) break; }
      } catch (error) { assistant.textContent = "Turn unavailable: " + error.message; assistant.style.color = "#ffb5b5"; }
      finally { sending = false; syncSelection(); }
    });
    discover();
  </script>
</body>
</html>`;

export function createPiPrototypeUiServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === ROUTE) {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(page);
      return;
    }
    if (request.method === "GET" && url.pathname === `${ROUTE}/api/models`) {
      const mode = url.searchParams.get("mode");
      if (mode !== "demo" && mode !== "live") {
        sendJson(response, 400, { error: "Choose demo or live discovery mode" });
        return;
      }
      await handleDiscovery(response, mode);
      return;
    }
    if (request.method === "POST" && url.pathname === `${ROUTE}/api/turn`) {
      await handleTurn(request, response);
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  });
}

export async function startPiPrototypeUiServer(port = 4317): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createPiPrototypeUiServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}${ROUTE}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const port = Number.parseInt(process.env.ROME_PI_PROTOTYPE_PORT ?? "4317", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ROME_PI_PROTOTYPE_PORT must be an integer between 1 and 65535");
  }
  const server = await startPiPrototypeUiServer(port);
  console.log(`Pi provider UI prototype: ${server.url}`);
  console.log(
    "Prototype only. Configure Pi in your own terminal; no CLI, shell, or PTY is exposed.",
  );
}
