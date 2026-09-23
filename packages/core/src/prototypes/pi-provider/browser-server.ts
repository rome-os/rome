import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { getDb } from "../../db/index.js";
import { SettingsRepository } from "../../db/repositories/settings.js";
import {
  PiChildPrototypeProvider,
  PiPrototypeCredentialStore,
  discoverPiModels,
} from "./pi-child-prototype.js";

const provider = "anthropic" as const;
const path = "/pi-prototype";
const safeError = "The prototype operation failed. No credential or provider detail was returned.";

const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pi isolated-child prototype</title><style>
body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem;color:#17202a}fieldset{margin:1rem 0;padding:1rem;border:1px solid #bbb;border-radius:8px}label{display:block;margin:.6rem 0}input,select,textarea,button{font:inherit;padding:.55rem}input,select,textarea{box-sizing:border-box;width:100%}button{margin:.3rem .3rem .3rem 0}.badge{display:inline-block;background:#7d2d13;color:white;padding:.25rem .5rem;border-radius:4px;font-weight:700}pre{white-space:pre-wrap;background:#f4f5f6;padding:1rem;min-height:3rem}.muted{color:#59636e}</style></head>
<body><span class="badge">THROWAWAY PROTOTYPE</span><h1>Isolated Pi provider child</h1>
<p class="muted">Anthropic only. The token is sent once in the request body, is never put in the URL or browser storage, and the field is cleared immediately.</p>
<fieldset><legend>1. Save a Rome-owned provider credential</legend><label>Provider<input value="anthropic" disabled></label><label>Provider API token<input id="token" type="password" autocomplete="off" spellcheck="false"></label><button id="save">Save</button><button id="remove">Remove</button><div id="status">Checking…</div></fieldset>
<fieldset><legend>2. Discover qualified models</legend><button id="discover">Discover</button><label>Qualified model ID<select id="models"></select></label></fieldset>
<fieldset><legend>3. Run one short turn</legend><label>Prompt<textarea id="prompt" maxlength="1000" rows="3">Reply with one short sentence.</textarea></label><button id="run">Run</button><button id="stop" disabled>Stop</button><pre id="output"></pre></fieldset>
<script src="${path}/app.js" defer></script></body></html>`;

const script = `(()=>{const $=id=>document.getElementById(id), token=$('token'), status=$('status'), models=$('models'), output=$('output');let controller;
const call=async(route,body)=>{const r=await fetch('${path}/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-pi-prototype':'1'},body:JSON.stringify(body||{})});const v=await r.json();if(!r.ok)throw Error(v.error||'Operation failed');return v};
const showStatus=s=>status.textContent=s.configured?'Configured (updated '+s.updatedAt+')':'Not configured';
async function refresh(){try{showStatus(await (await fetch('${path}/api/status',{cache:'no-store'})).json())}catch{status.textContent='Status unavailable'}}
$('save').onclick=async()=>{const value=token.value;token.value='';try{showStatus(await call('save',{token:value}))}catch(e){alert(e.message)}};
$('remove').onclick=async()=>{token.value='';if(confirm('Remove the Anthropic prototype credential?'))try{showStatus(await call('remove'))}catch(e){alert(e.message)}};
$('discover').onclick=async()=>{models.replaceChildren();try{const v=await call('discover');for(const m of v.models){const o=document.createElement('option');o.value=m.id;o.textContent=m.id;models.append(o)}}catch(e){alert(e.message)}};
$('run').onclick=async()=>{if(!models.value)return alert('Discover and select a model first.');output.textContent='';controller=new AbortController();$('run').disabled=true;$('stop').disabled=false;try{const r=await fetch('${path}/api/run',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json','x-pi-prototype':'1'},body:JSON.stringify({model:models.value,prompt:$('prompt').value})});if(!r.ok){const v=await r.json();throw Error(v.error||'Operation failed')}const reader=r.body.getReader(),decoder=new TextDecoder();let pending='';for(;;){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});const lines=pending.split('\n');pending=lines.pop();for(const line of lines){if(!line)continue;const e=JSON.parse(line);if(e.type==='text_delta')output.textContent+=e.content;if(e.type==='error')throw Error(e.message)}}}catch(e){if(e.name!=='AbortError')alert(e.message)}finally{controller=undefined;$('run').disabled=false;$('stop').disabled=true}};
$('stop').onclick=()=>controller?.abort();addEventListener('beforeunload',()=>{token.value='';controller?.abort()});refresh()})();`;

function headers(c: { header(name: string, value: string): void }): void {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
  );
}

export function createPiPrototypeBrowserApp(credentials: PiPrototypeCredentialStore) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    headers(c);
    await next();
  });
  app.get("/health", (c) => c.json({ ok: true, prototype: "pi-isolated-child" }));
  app.get(`${path}/`, (c) => c.html(page));
  app.get(`${path}/app.js`, (c) =>
    c.body(script, 200, { "Content-Type": "text/javascript; charset=utf-8" }),
  );
  app.get(`${path}/api/status`, async (c) => c.json(await credentials.status(provider)));
  app.use(`${path}/api/*`, async (c, next) => {
    if (c.req.method !== "GET" && c.req.header("x-pi-prototype") !== "1")
      return c.json({ error: safeError }, 403);
    await next();
  });
  app.post(`${path}/api/save`, async (c) => {
    try {
      const body = await c.req.json<{ token?: unknown }>();
      if (typeof body.token !== "string") return c.json({ error: "Enter a token." }, 400);
      return c.json(await credentials.save(provider, body.token));
    } catch {
      return c.json({ error: safeError }, 400);
    }
  });
  app.post(`${path}/api/remove`, async (c) => c.json(await credentials.remove(provider)));
  app.post(`${path}/api/discover`, async (c) => {
    try {
      return c.json({ models: await discoverPiModels(credentials, provider) });
    } catch {
      return c.json({ error: safeError }, 400);
    }
  });
  app.post(`${path}/api/run`, async (c) => {
    let body: { model?: unknown; prompt?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: safeError }, 400);
    }
    if (
      typeof body.model !== "string" ||
      typeof body.prompt !== "string" ||
      !body.prompt.trim() ||
      body.prompt.length > 1000
    )
      return c.json({ error: "Choose a model and enter a short prompt." }, 400);
    const runtime = new PiChildPrototypeProvider(credentials);
    return streamText(c, async (stream) => {
      const session = await runtime.openSession({
        model: body.model as string,
        systemPrompt: "Answer briefly. This is an isolated Pi provider prototype.",
        sessionId: crypto.randomUUID(),
        getActionCatalog: () => [],
        getSkillCatalog: () => [],
        subagentTools: [],
        executeAction: async () => undefined,
        executeSubagent: async () => undefined,
      });
      stream.onAbort(async () => {
        await session.interrupt();
        await session.close();
      });
      try {
        await session.sendUserInput({ text: body.prompt as string });
        for await (const event of session.events) {
          if (event.type === "text_delta")
            await stream.writeln(JSON.stringify({ type: "text_delta", content: event.content }));
          if (event.type === "result") {
            await stream.writeln(JSON.stringify({ type: "done" }));
            break;
          }
          if (event.type === "error") {
            await stream.writeln(JSON.stringify({ type: "error", message: safeError }));
            break;
          }
        }
      } catch {
        await stream.writeln(JSON.stringify({ type: "error", message: safeError }));
      } finally {
        await session.close();
      }
    });
  });
  return app;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const host = process.env.PI_PROTOTYPE_HOST ?? "127.0.0.1";
  const port = Number(process.env.PI_PROTOTYPE_PORT ?? "4397");
  const credentials = new PiPrototypeCredentialStore(new SettingsRepository(getDb()));
  serve({ fetch: createPiPrototypeBrowserApp(credentials).fetch, hostname: host, port }, () => {
    process.stdout.write(`Pi browser prototype listening on http://${host}:${port}${path}/\n`);
  });
}
