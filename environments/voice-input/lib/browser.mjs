// Starts the environment's Chrome: headless, signed in as the guardian, with
// a recording as its microphone, the microphone permission set as asked, and
// every request routed through the environment's proxy. Prints how to
// connect to it as JSON and leaves it running.
//
//   node browser.mjs --mic <wav> --permission unset|granted|refused --lang en|zh-CN
//     --chrome <path> --dashboard <url> --cdp-port <n> --proxy-port <n>
//     --profile <dir> --user <id>   (the guardian's password comes on stdin)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../../../packages/web/package.json"));
const { chromium } = require("@playwright/test");

const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
// Chrome's content setting values: 1 allows, 2 blocks. Unset writes none, so
// the page gets Chrome's own prompt.
const SETTINGS = { unset: 0, granted: 1, refused: 2 };
const LANGS = { en: "en-US", "zh-CN": "zh-CN" };

function fail(message) {
  console.error(`voice-env browser: ${message}`);
  process.exit(1);
}
if (!args.mic || !existsSync(args.mic)) fail(`no recording at ${args.mic}`);
const setting = SETTINGS[args.permission ?? "granted"];
if (setting === undefined) fail("--permission is unset, granted or refused");
const lang = LANGS[args.lang ?? "en"] ?? fail("--lang is en or zh-CN");
// stdin: {"password": "...", "cookies": [...]}, the cookies from the last
// launch, reused while Rome still accepts them, since Rome limits how often
// one address may sign in.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { password, cookies: saved = [] } = JSON.parse(input);

async function until(what, test, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await test();
      if (v) return v;
    } catch {}
    if (Date.now() > end) fail(`${what} did not come up`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const proxy = `http://127.0.0.1:${args["proxy-port"]}`;
let proxyPid = null;
const proxyUp = () => fetch(`${proxy}/__voice-env/state`).then((r) => r.ok);
if (!(await proxyUp().catch(() => false))) {
  const child = spawn(
    process.execPath,
    [resolve(here, "proxy.mjs"), "--port", args["proxy-port"]],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  proxyPid = child.pid;
  await until("the proxy", proxyUp);
}

// A fresh profile per launch, so no permission or cookie carries over.
// Refuse a debugging port something else holds, or the verifier would
// connect to that other browser instead of this one.
const cdpTaken = await fetch(`http://127.0.0.1:${args["cdp-port"]}/json/version`).then(
  () => true,
  () => false,
);
if (cdpTaken)
  fail(
    `port ${args["cdp-port"]} is already taken; stop whatever holds it (ss -ltnp | grep ${args["cdp-port"]})`,
  );

// The permission is written into the profile before Chrome starts, as if the
// guardian had answered Chrome's prompt on an earlier visit. A permission set
// over the debugging protocol would end when that connection closes.
rmSync(args.profile, { recursive: true, force: true });
mkdirSync(`${args.profile}/Default`, { recursive: true });
const origin = new URL(args.dashboard).origin;
const exceptions = setting
  ? { [`${origin},*`]: { setting, last_modified: "13300000000000000" } }
  : {};
writeFileSync(
  `${args.profile}/Default/Preferences`,
  JSON.stringify({
    intl: {
      accept_languages: lang === "zh-CN" ? "zh-CN,zh" : "en-US,en",
      selected_languages: lang === "zh-CN" ? "zh-CN,zh" : "en-US,en",
    },
    profile: { content_settings: { exceptions: { media_stream_mic: exceptions } } },
  }),
);
const chrome = spawn(
  args.chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${args["cdp-port"]}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${args.profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${resolve(args.mic)}%noloop`,
    `--proxy-server=${proxy}`,
    // Loopback goes through the proxy too, so the dashboard's own traffic is
    // recorded and can be cut.
    "--proxy-bypass-list=<-loopback>",
    `--lang=${lang}`,
    `--accept-lang=${lang}`,
    "--autoplay-policy=no-user-gesture-required",
    // Chrome's own background traffic (updates, sync, Google services) stays
    // out of the capture. None of it is the dashboard's.
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--no-pings",
    "about:blank",
  ],
  { detached: true, stdio: "ignore", env: { ...process.env, LANGUAGE: lang.replace("-", "_") } },
);
chrome.unref();
const cdp = `http://127.0.0.1:${args["cdp-port"]}`;
const version = await until("Chrome", () =>
  fetch(`${cdp}/json/version`).then((r) => r.ok && r.json()),
);

async function signIn() {
  const header = saved.map((c) => `${c.name}=${c.value}`).join("; ");
  if (header) {
    const me = await fetch(`${args.dashboard}/api/auth/me`, { headers: { cookie: header } });
    if (me.ok && (await me.json()).kind === "guardian") return saved;
  }
  const login = await fetch(`${args.dashboard}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: args.user, password }),
  });
  if (!login.ok) fail(`the guardian could not sign in: ${login.status} ${await login.text()}`);
  return login.headers.getSetCookie().map((c) => {
    const [pair] = c.split(";");
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: args.dashboard };
  });
}
const cookies = await signIn();

const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];
await context.addCookies(cookies);
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(args.dashboard);
const state = await page.evaluate(() =>
  navigator.permissions.query({ name: "microphone" }).then((p) => p.state),
);

console.log(
  JSON.stringify({
    cdp,
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    dashboard: args.dashboard,
    signedInAs: args.user,
    mic: resolve(args.mic),
    permission: args.permission ?? "granted",
    permissionState: state,
    lang,
    proxy,
    pid: chrome.pid,
    proxyPid,
    cookies,
  }),
);
process.exit(0);
