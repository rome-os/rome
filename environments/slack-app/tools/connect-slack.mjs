// Connects Rome's Slack app to an instance as its guardian, the way the
// dashboard's Connect and a browser do: it starts the slack_app bot setup,
// follows the sign-in through Rome Cloud and the fake Slack's approve screen
// (pressing Allow, keeping every preselected choice), and waits for the setup
// to end. An instance that already holds a slack_app connection is left as it
// is. Prints one JSON line {instance, outcome, connection_id, ...} and exits 0
// when the instance is connected. Called by ctl.sh connect.
//
// Usage: node connect-slack.mjs --instance <url> --cookies <file> --slack <fake Slack url>
//          [--cloud-sign-in <dev sign-in url ending in email=> --email <guardian>] [--name <instance>]
//          [--timeout <seconds>]

import { readFileSync } from "node:fs";

const KIND = "slack_app";
const GRANT = "bot";

/** A small browser: cookies per origin, redirects followed by hand. */
export function browser({ aliases = {} } = {}) {
  const jar = new Map();
  const aliased = (url) => {
    const u = new URL(url);
    const to = aliases[u.origin];
    return to ? `${to}${u.pathname}${u.search}` : url;
  };
  const keep = (url, res) => {
    const origin = new URL(url).origin;
    const held = jar.get(origin) ?? new Map();
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) held.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    jar.set(origin, held);
  };
  async function follow(url, { method = "GET", form, stopAt = () => false } = {}) {
    const visited = [];
    let next = url;
    let verb = method.toUpperCase();
    let body = form ? new URLSearchParams(form).toString() : undefined;
    if (form && verb === "GET") {
      const to = new URL(url);
      to.search = body;
      next = to.toString();
      body = undefined;
    }
    for (let i = 0; i < 15; i++) {
      visited.push(next);
      if (stopAt(new URL(next))) return { stoppedAt: new URL(next), visited };
      const held = jar.get(new URL(next).origin);
      const res = await fetch(aliased(next), {
        method: verb,
        redirect: "manual",
        headers: {
          ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(held?.size ? { cookie: [...held].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        },
        body,
      });
      keep(next, res);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        next = new URL(location, next).toString();
        verb = "GET";
        body = undefined;
        continue;
      }
      return { status: res.status, url: new URL(next), html: await res.text(), visited };
    }
    throw new Error(`more than 15 redirects from ${url}`);
  }
  return { follow };
}

/** Every form in `html`: action, method, hidden inputs, selected options, buttons. */
export function forms(html, base) {
  const attr = (a, n) => {
    const m = a.match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return m ? (m[2] ?? m[3] ?? m[4] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"') : undefined;
  };
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(([, a, inner]) => {
    const hidden = {};
    const chosen = {};
    const buttons = [];
    for (const s of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const opt = s[2].match(/<option\b([^>]*\bselected\b[^>]*)>/i) ?? s[2].match(/<option\b([^>]*)>/i);
      if (attr(s[1], "name") && opt) chosen[attr(s[1], "name")] = attr(opt[1], "value") ?? "";
    }
    for (const t of inner.matchAll(/<(input|button)\b([^>]*)>/gi)) {
      const type = (attr(t[2], "type") ?? (t[1].toLowerCase() === "button" ? "submit" : "text")).toLowerCase();
      if (type === "submit") buttons.push({ name: attr(t[2], "name"), value: attr(t[2], "value") ?? "" });
      else if (type === "hidden" && attr(t[2], "name")) hidden[attr(t[2], "name")] = attr(t[2], "value") ?? "";
    }
    return {
      action: new URL(attr(a, "action") ?? base, base).toString(),
      method: (attr(a, "method") ?? "GET").toUpperCase(),
      fields: { ...hidden, ...chosen },
      buttons,
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Connects the instance at `instanceUrl`. `cookies` is the guardian's session
 * on it as a cookie map. Returns {outcome: "connected" | "already" |
 * "refused" | "stuck", connection_id, reason?, path}.
 */
export async function connect({ instanceUrl, cookies, slack, cloudSignIn, email, timeoutMs = 120_000 }) {
  const origin = new URL(instanceUrl).origin;
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  // Rome refuses a mutation not from its own origin, as the dashboard's are.
  const call = async (path, init = {}) => {
    const res = await fetch(`${origin}/api${path}`, {
      ...init,
      headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", cookie },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    return { status: res.status, ok: res.ok, data };
  };
  const held = async () => {
    const res = await call("/connections");
    const list = Array.isArray(res.data) ? res.data : (res.data?.connections ?? []);
    return list.find((c) => c?.id && (c.connectionKind ?? c.kind) === KIND && c.state !== "disconnected") ?? null;
  };
  const already = await held();
  if (already) return { outcome: "already", connection_id: already.id, state: already.state ?? null, path: [] };

  // https://slack.com, where Rome Cloud's Worker sends the approve screen,
  // is the fake Slack inside the stack; on the host it is the fake's port.
  const { follow } = browser({ aliases: { "https://slack.com": new URL(slack).origin } });
  const path = [];
  if (cloudSignIn && email) await follow(`${cloudSignIn}${encodeURIComponent(email)}`);

  const setup = `/connections/${KIND}/grants/${GRANT}/setup`;
  let started = await call(setup, { method: "POST", body: {} });
  if (started.ok && started.data?.reattached) started = await call(setup, { method: "POST", body: { force: true } });
  if (!started.ok) return { outcome: "stuck", reason: `start setup: ${started.status} ${JSON.stringify(started.data)}`, path };
  const cid = started.data.cid;
  let state = started.data.state;
  const backHere = (u) => u.origin === origin && u.searchParams.has("state");
  let signedIn = false;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (state?.status === "done") {
      const c = await held();
      return { outcome: "connected", connection_id: state.grant?.connectionId ?? c?.id ?? null, path };
    }
    if (state?.status === "failed") return { outcome: "refused", reason: state.reason, path };
    if (state?.status === "cancelled") return { outcome: "stuck", reason: "cancelled", path };
    if (state?.status === "awaiting-input")
      return { outcome: "stuck", reason: `setup asked for ${state.form?.fields?.length ?? "some"} field(s)`, path };
    const link =
      state?.status === "awaiting-redirect"
        ? state.url
        : state?.status === "presenting"
          ? state.view?.links?.find((l) => l?.url)?.url
          : null;
    if (link && !signedIn) {
      signedIn = true;
      let leg = await follow(link, { stopAt: backHere });
      for (let screens = 0; ; screens++) {
        path.push(...leg.visited.map((v) => new URL(v).origin + new URL(v).pathname));
        if (leg.stoppedAt) {
          // The sign-in came back to this instance: hand it the parameters.
          const ret = await call("/setups/return", { method: "POST", body: Object.fromEntries(leg.stoppedAt.searchParams) });
          if (ret.data?.state) state = ret.data.state;
          break;
        }
        const form = forms(leg.html, leg.url)[0];
        if (!form || screens >= 5) {
          // Rome Cloud's callback page ends the sign-in; a page that is not
          // 200 says why it was refused.
          if (leg.status !== 200)
            return { outcome: "refused", reason: `${leg.url.pathname} answered ${leg.status}: ${leg.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}`, path };
          break;
        }
        const press = form.buttons.find((b) => b.value === "allow") ?? form.buttons.find((b) => b.name) ?? {};
        leg = await follow(form.action, {
          method: form.method,
          form: { ...form.fields, ...(press.name ? { [press.name]: press.value } : {}) },
          stopAt: backHere,
        });
      }
    }
    await sleep(500);
    const polled = await call(`/setups/${cid}`);
    if (polled.ok) state = polled.data?.state ?? state;
  }
  return { outcome: "stuck", reason: `setup did not end in ${timeoutMs / 1000} s (last ${state?.status})`, path };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = {};
  for (let i = 2; i < process.argv.length; i += 2) flags[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  const result = await connect({
    instanceUrl: flags.instance,
    cookies: JSON.parse(readFileSync(flags.cookies, "utf8")),
    slack: flags.slack,
    cloudSignIn: flags["cloud-sign-in"],
    email: flags.email,
    timeoutMs: Number(flags.timeout ?? 120) * 1000,
  }).catch((err) => ({ outcome: "stuck", reason: String(err?.message ?? err) }));
  console.log(JSON.stringify({ instance: flags.name ?? flags.instance, ...result }));
  process.exit(result.outcome === "connected" || result.outcome === "already" ? 0 : 1);
}
