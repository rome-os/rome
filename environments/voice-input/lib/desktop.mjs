// Signs the desktop app's window in as the guardian, once the container is
// up, and prints how to connect to it as JSON, as browser.mjs does for Chrome.
//
//   node desktop.mjs --cdp-port <n> --dashboard <url> --user <id> --lang <tag>
//     (the guardian's password and the last cookies come on stdin)
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../../../packages/web/package.json"));
const { chromium } = require("@playwright/test");

const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

function fail(message) {
  console.error(`voice-env desktop: ${message}`);
  process.exit(1);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { password, cookies: saved = [] } = JSON.parse(input);

async function until(what, test, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await test();
      if (v) return v;
    } catch {}
    if (Date.now() > end) fail(`${what} did not come up`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const cdp = `http://127.0.0.1:${args["cdp-port"]}`;
const version = await until("the desktop app", () =>
  fetch(`${cdp}/json/version`).then((r) => r.ok && r.json()),
);
// The window exists once the shell has opened the dashboard.
await until("the desktop app's window", () =>
  fetch(`${cdp}/json`)
    .then((r) => r.json())
    .then((pages) => pages.some((p) => p.type === "page" && p.url.startsWith(args.dashboard))),
);

// The same sign-in as browser.mjs: the host reaches Rome at the same address
// the shell does inside its container.
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

const app = await chromium.connectOverCDP(cdp);
const context = app.contexts()[0];
await context.addCookies(cookies);
// Reload only once the shell's own first load has finished: navigating while
// it loads aborts that load, and the shell gives up on the dashboard.
const page = await until("the dashboard's first load", async () => {
  const p = context.pages().find((q) => q.url().startsWith(args.dashboard));
  return p && (await p.evaluate(() => document.readyState)) === "complete" && p;
});
await page.reload();
// The shell's preload bridge says whether this app gives the dashboard the
// microphone; the dashboard shows its voice control only when it does.
const shell = await page.evaluate(async () => ({
  bridgeMicrophone: globalThis.rome?.microphone ?? null,
  permissionState: (await navigator.permissions.query({ name: "microphone" })).state,
}));

console.log(
  JSON.stringify({
    cdp,
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    dashboard: args.dashboard,
    signedInAs: args.user,
    lang: args.lang,
    permission: "granted",
    permissionState: shell.permissionState,
    bridgeMicrophone: shell.bridgeMicrophone,
    cookies,
  }),
);
process.exit(0);
