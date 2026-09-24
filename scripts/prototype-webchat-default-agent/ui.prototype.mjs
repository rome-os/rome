#!/usr/bin/env node
// PROTOTYPE (webchat-default-agent): headless-browser checks against the local
// instance. Each browser profile ("a", "b") is a separate persistent Chromium
// profile, i.e. a separate browser for the "second browser" check.
//   node scripts/prototype-webchat-default-agent/ui.prototype.mjs <flow> [profile]
// Flows: advanced | s1 | entry | swap | remove | blank
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

// playwright is a transitive dev dependency; resolve it from pnpm's hoist dir.
const require = createRequire(new URL("../../node_modules/.pnpm/node_modules/", import.meta.url));
const { chromium } = require("playwright");
const BASE = process.env.WDA_BASE ?? "http://127.0.0.1:4310";
const OUT = process.env.WDA_OUT ?? "/tmp/wda/shots";
mkdirSync(OUT, { recursive: true });
const [flow, profile = "a"] = process.argv.slice(2);
const ts = () => new Date().toISOString();
const trace = (event, data) => console.log(`${ts()} ${event} ${JSON.stringify(data ?? {})}`);

const ctx = await chromium.launchPersistentContext(`/tmp/wda/browser-${profile}`, {
  viewport: { width: 1400, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("console", (m) => {
  if (m.text().includes("[wda-proto]")) trace("browser-console", { text: m.text() });
});

page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/chat/default-agent") || u.endsWith("/api/chat/agents")) {
    trace("browser-fetch", {
      method: r.request().method(),
      path: new URL(u).pathname,
      status: r.status(),
    });
  }
});

async function login() {
  const me = await page.request.get(`${BASE}/api/auth/me`);
  if (me.ok()) return trace("login", { profile, reused: true });
  const r = await page.request.post(`${BASE}/api/auth/login`, {
    data: { userId: "proto", password: "proto-pass-123" },
  });
  trace("login", { profile, status: r.status() });
}

async function api(path) {
  return (await page.request.get(`${BASE}${path}`)).json();
}

async function seedLine() {
  const el = page.getByTestId("wda-proto-seed");
  await el.waitFor({ timeout: 20000 });
  // Wait until the latch settles (the line stops saying "pending").
  for (let i = 0; i < 100; i++) {
    const t = await el.innerText();
    if (!t.includes("pending")) return t;
    await page.waitForTimeout(100);
  }
  return el.innerText();
}

async function chipState(label) {
  const remove = page.getByRole("button", { name: "Remove agent" });
  const present = (await remove.count()) > 0;
  const chipText = present
    ? await remove.first().evaluate((b) => b.parentElement?.innerText ?? "")
    : null;
  const state = { label, chipPresent: present, chipText };
  trace("composer-chip", state);
  return state;
}

async function openBlankDraft(name) {
  await page.goto(`${BASE}/chat`, { waitUntil: "load" });
  const line = await seedLine();
  trace("seed-line", { line });
  await page.waitForTimeout(500);
  await chipState(name);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function send(text) {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 30000 });
  const id = page.url().split("/chat/")[1].split(/[/?#]/)[0];
  trace("sent", { text, sessionId: id });
  return id;
}

async function waitForReplies(sessionId, count) {
  for (let i = 0; i < 180; i++) {
    const msgs = await api(`/api/chat/sessions/${sessionId}/messages`);
    const list = Array.isArray(msgs) ? msgs : (msgs.messages ?? []);
    const assistant = list.filter((m) => m.role === "assistant");
    if (assistant.length >= count) return list;
    await page.waitForTimeout(1000);
  }
  return [];
}

async function sessionAgent(sessionId) {
  const s = await api(`/api/chat/sessions/${sessionId}`);
  trace("session", { sessionId, agentName: s.agentName ?? null });
  return s.agentName ?? null;
}

async function defaultState(label) {
  const d = await api("/api/chat/default-agent");
  trace("default-agent", { label, saved: d.saved?.agentName ?? null, effective: d.effective });
}

await login();
switch (flow) {
  case "advanced": {
    await page.goto(`${BASE}/settings/advanced`, { waitUntil: "load" });
    const box = page.getByTestId("wda-proto-advanced");
    await box.waitFor({ timeout: 20000 });
    await page.waitForTimeout(1000);
    trace("advanced", { profile, text: await box.innerText() });
    await box.screenshot({ path: `${OUT}/advanced-${profile}-${Date.now()}.png` });
    break;
  }
  case "advanced-set": {
    // Save through the rough Advanced control itself (arg: agent id or "main").
    const value = process.argv[4] ?? "wda-proto-app:helper";
    await page.goto(`${BASE}/settings/advanced`, { waitUntil: "load" });
    const select = page.locator("#wda-proto-select");
    await select.waitFor({ timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector("#wda-proto-select")?.disabled);
    await select.selectOption(value);
    await page.waitForTimeout(1500);
    const box = page.getByTestId("wda-proto-advanced");
    trace("advanced-after-select", { value, text: (await box.innerText()).split("\n").pop() });
    await box.screenshot({ path: `${OUT}/advanced-set-${profile}.png` });
    await defaultState("server-after-ui-select");
    break;
  }
  case "window": {
    // Open a blank draft while an upgrade has the agent out of the catalog.
    const source = process.argv[4];
    await page.goto(`${BASE}/apps`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const install = page.request.post(`${BASE}/api/apps`, {
      data: { source: { mode: "source", path: source } },
      timeout: 120000,
    });
    for (let i = 0; i < 400; i++) {
      const d = await api("/api/chat/default-agent");
      if (d.effective === "main") {
        trace("window-open", { saved: d.saved?.agentName, savedLoaded: d.savedLoaded });
        break;
      }
      await page.waitForTimeout(25);
    }
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("rome:host-navigate", { detail: { path: "/chat" } })),
    );
    trace("seed-line", { line: await seedLine() });
    await chipState("draft-opened-in-window");
    trace("install-finished", { status: (await install).status() });
    await page.waitForTimeout(12000);
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(1500);
    trace("seed-line-after-window", { line: await page.getByTestId("wda-proto-seed").innerText() });
    await chipState("same-draft-after-window");
    await defaultState("after-window");
    break;
  }
  case "blank": {
    await openBlankDraft(`blank-${profile}-${Date.now()}`);
    break;
  }
  case "s1": {
    await openBlankDraft("s1-blank-draft");
    const id = await send("Turn one: say hello.");
    await waitForReplies(id, 1);
    await page.waitForTimeout(1500);
    await chipState("s1-after-first-turn");
    const box = page.locator("textarea").first();
    await box.fill("Turn two: say goodbye.");
    await box.press("Enter");
    const list = await waitForReplies(id, 2);
    for (const m of list) {
      const blocks = m.blocks ?? [];
      trace("message", {
        role: m.role,
        agents: [...new Set(blocks.map((b) => b.agent).filter(Boolean))],
        text: String(m.content ?? blocks.find((b) => b.type === "text")?.content ?? "").slice(
          0,
          90,
        ),
      });
    }
    await sessionAgent(id);
    await page.screenshot({ path: `${OUT}/s1-session.png` });
    await defaultState("after-s1");
    break;
  }
  case "entry": {
    // A real entry point: what navigateRome({ path: "chat/new", agentName }) does.
    await page.goto(`${BASE}/apps`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("rome:host-navigate", {
          detail: { path: "/chat", state: { agentName: "coding:coding" } },
        }),
      ),
    );
    trace("seed-line", { line: await seedLine() });
    await page.waitForTimeout(800);
    await chipState("entry-point-draft");
    await page.screenshot({ path: `${OUT}/s2-entry-draft.png` });
    const id = await send("Entry point check.");
    await sessionAgent(id);
    await defaultState("after-entry");
    break;
  }
  case "swap": {
    await openBlankDraft("s2-swap-before");
    await page.getByRole("button", { name: "Remove agent" }).first().click();
    const box = page.locator("textarea").first();
    await box.click();
    await box.pressSequentially("@assistant");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/s2-swap-menu.png` });
    await box.press("Enter"); // pick app group
    await page.waitForTimeout(500);
    await box.press("Enter"); // pick first agent in group
    await page.waitForTimeout(800);
    await chipState("after-swap");
    await page.screenshot({ path: `${OUT}/s2-swap-after.png` });
    const id = await send("Swap check.");
    await sessionAgent(id);
    await defaultState("after-swap");
    break;
  }
  case "remove": {
    await openBlankDraft("s2-remove-before");
    await page.getByRole("button", { name: "Remove agent" }).first().click();
    await chipState("after-remove-click");
    // Force a real refetch with *changed* data: another browser saves a different
    // default, the queries go stale (app staleTime is 10s), then window focus.
    await page.request.put(`${BASE}/api/chat/default-agent`, {
      data: { agentName: "assistant:assistant" },
    });
    await page.waitForTimeout(11000);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    const box = page.locator("textarea").first();
    await box.click();
    await box.pressSequentially("Removal check.");
    await page.waitForTimeout(2500);
    trace("seed-line", { line: await page.getByTestId("wda-proto-seed").innerText() });
    await chipState("after-refetch-and-rerender");
    await page.screenshot({ path: `${OUT}/s2-remove-after.png` });
    await box.press("Enter");
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 30000 });
    const id = page.url().split("/chat/")[1].split(/[/?#]/)[0];
    await sessionAgent(id);
    await defaultState("after-remove");
    await page.request.put(`${BASE}/api/chat/default-agent`, {
      data: { agentName: "wda-proto-app:helper" },
    });
    await defaultState("restored-for-next-scenario");
    break;
  }
  default:
    console.error("unknown flow", flow);
}
await ctx.close();
