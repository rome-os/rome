// HTTP helpers for the verifier: JSON calls and a small browser that follows
// redirects and reads HTML forms, enough to walk a sign-in.

// No request, body read included, may outlast this, so a stalled endpoint
// cannot hold a check past its own deadline by more than this much.
const REQUEST_MS = 15_000;

/**
 * Calls `url` and parses a JSON answer. Never throws on a non-2xx status; an
 * endpoint that cannot be reached throws `Unreachable` (see `request`).
 */
export async function json(url, { method = "GET", body, headers = {}, retry = true } = {}) {
  const res = await request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    retry,
  });
  const text = await readBody(res, url, method);
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

// How long a request keeps trying an endpoint it cannot connect to, so a
// check rides out an instance restart (a wipe restarts it for about 15 s).
let reachMs = 90_000;

/** Sets how long `request` retries an endpoint it cannot connect to. */
export function setReachSeconds(seconds) {
  reachMs = seconds * 1000;
}

// The step a rule is on, and its last requests, for a report that names
// what was being done when a request failed.
let currentPhase = null;
const trail = [];
const TRAIL_MAX = 12;

/** Names the step the running rule is on; the label goes into failure reports. */
export function phase(label) {
  currentPhase = label;
}

/** Clears the step and the request trail, at the start of each rule. */
export function resetTrail() {
  currentPhase = null;
  trail.length = 0;
}

/** The step and the last requests made, oldest first. */
export function lastRequests() {
  return { phase: currentPhase, requests: [...trail] };
}

/**
 * A request that never got an answer: the endpoint refused the connection,
 * reset it, or timed out, across every retry. `sent` says whether the request
 * may have reached the endpoint before it failed.
 */
export class Unreachable extends Error {
  constructor(info) {
    super(
      `could not reach ${info.host}: ${info.method} ${info.url} failed after ${info.attempts} attempt(s) over ${info.seconds} s (${info.cause})${info.phase ? `, during "${info.phase}"` : ""}`,
    );
    this.name = "Unreachable";
    this.info = info;
  }
}

// Failures where the request never reached the endpoint, so any method may
// be sent again.
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
// Failures where it may have; only a GET or HEAD is sent again.
const MAYBE_SENT = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "TimeoutError", "AbortError"]);

/** The code and message under a fetch failure, which says only "fetch failed" itself. */
function causeOf(err) {
  let e = err;
  const chain = [];
  while (e && chain.length < 4) {
    chain.push(e);
    e = e.cause;
  }
  const deepest = chain.at(-1);
  const code = chain.map((x) => x.code ?? (x.name !== "Error" && x.name !== "TypeError" ? x.name : undefined)).find(Boolean) ?? null;
  return { code, text: `${code ? `${code}: ` : ""}${deepest?.message ?? String(err)}` };
}

/**
 * fetch with a deadline per attempt, a record in the trail, and retries while
 * the endpoint cannot be reached, for up to the reach window. `retry: false`
 * tries once, for probes that expect a stopped endpoint.
 */
export async function request(url, { retry = true, ...init } = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  const started = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    const at = new Date().toISOString();
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
      remember({ at, method, url: String(url), status: res.status });
      return res;
    } catch (err) {
      const cause = causeOf(err);
      remember({ at, method, url: String(url), error: cause.text });
      const again = NEVER_SENT.has(cause.code) || (idempotent && MAYBE_SENT.has(cause.code));
      if (!retry || !again || Date.now() - started >= reachMs) {
        throw new Unreachable({
          url: String(url),
          host: new URL(url).host,
          method,
          phase: currentPhase,
          cause: cause.text,
          attempts,
          seconds: Math.round((Date.now() - started) / 1000),
          sent: NEVER_SENT.has(cause.code) ? false : "maybe",
        });
      }
      await sleep(Math.min(3000, 500 * attempts));
    }
  }
}

/** Reads a body; a connection lost mid-body is reported like any other. */
async function readBody(res, url, method) {
  try {
    return await res.text();
  } catch (err) {
    const cause = causeOf(err);
    throw new Unreachable({
      url: String(url),
      host: new URL(url).host,
      method,
      phase: currentPhase,
      cause: `answered ${res.status}, then the body failed: ${cause.text}`,
      attempts: 1,
      seconds: 0,
      sent: true,
    });
  }
}

function remember(entry) {
  trail.push(currentPhase ? { phase: currentPhase, ...entry } : entry);
  if (trail.length > TRAIL_MAX) trail.shift();
}

/**
 * Follows redirects by hand from `url` and stops at the first answer that is
 * not a redirect, or at the first URL `stopAt` accepts. Returns every URL
 * visited, so a caller can show the path the sign-in took.
 */
export async function follow(url, { method = "GET", form, stopAt = () => false, max = 15 } = {}) {
  const visited = [];
  let next = url;
  let nextMethod = method.toUpperCase();
  let nextBody;
  if (form && (nextMethod === "GET" || nextMethod === "HEAD")) {
    // A GET form sends its fields as the query, replacing the action's own.
    const to = new URL(url);
    to.search = new URLSearchParams(form).toString();
    next = to.toString();
  } else if (form) {
    nextBody = new URLSearchParams(form).toString();
  }
  for (let i = 0; i < max; i++) {
    visited.push(next);
    if (stopAt(new URL(next))) return { stoppedAt: new URL(next), visited };
    const res = await request(next, {
      method: nextMethod,
      redirect: "manual",
      headers: nextBody ? { "content-type": "application/x-www-form-urlencoded" } : {},
      body: nextBody,
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      next = new URL(location, next).toString();
      nextMethod = "GET";
      nextBody = undefined;
      continue;
    }
    return { status: res.status, url: new URL(next), html: await readBody(res, next, nextMethod), visited };
  }
  throw new Error(`more than ${max} redirects from ${url}`);
}

/**
 * Reads every `<form>` in `html`: its action, method and inputs. Hidden inputs
 * come back apart from the ones a person would fill, so a caller can count
 * what a screen asks for. `defaults` holds each select's chosen option.
 */
export function forms(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = m[1];
    const inner = m[2];
    const action = attr(attrs, "action") ?? baseUrl.toString();
    const method = (attr(attrs, "method") ?? "GET").toUpperCase();
    const hidden = {};
    const defaults = {};
    const fields = [];
    const buttons = [];
    for (const s of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = attr(s[1], "name");
      const chosen =
        s[2].match(/<option\b([^>]*\bselected\b[^>]*)>/i) ?? s[2].match(/<option\b([^>]*)>/i);
      if (name && chosen) defaults[name] = attr(chosen[1], "value") ?? "";
    }
    for (const t of inner.matchAll(/<(input|select|textarea|button)\b([^>]*)>/gi)) {
      const tag = t[1].toLowerCase();
      const a = t[2];
      const name = attr(a, "name");
      const type = (attr(a, "type") ?? (tag === "button" ? "submit" : "text")).toLowerCase();
      if (tag === "button" || type === "submit") {
        buttons.push({ name, value: attr(a, "value") ?? "" });
      } else if (type === "hidden") {
        if (name) hidden[name] = attr(a, "value") ?? "";
      } else {
        fields.push({ tag, name, type });
      }
    }
    out.push({
      action: new URL(action, baseUrl).toString(),
      method,
      hidden,
      defaults,
      fields,
      buttons,
    });
  }
  return out;
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return undefined;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
}

const ENTITIES = { amp: "&", quot: '"', "#39": "'", lt: "<", gt: ">" };

// One pass, so an entity that decodes to `&` is never decoded again.
function decodeEntities(s) {
  return s.replace(/&(amp|quot|#39|lt|gt|#\d+);/g, (_whole, name) =>
    name in ENTITIES ? ENTITIES[name] : String.fromCharCode(Number(name.slice(1))),
  );
}

/** Resolves after `ms` milliseconds. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `probe` until it returns a truthy value or `timeoutMs` passes, and
 * returns the last value either way. A probe still running at the deadline is
 * not waited for: its answer counts as falsy.
 */
export async function waitFor(probe, { timeoutMs, everyMs = 500 }) {
  const end = Date.now() + timeoutMs;
  const bounded = () => {
    let timer;
    const late = new Promise((r) => {
      timer = setTimeout(() => r(undefined), Math.max(0, end - Date.now()));
    });
    return Promise.race([probe(), late]).finally(() => clearTimeout(timer));
  };
  let last = await bounded();
  while (!last && Date.now() < end) {
    await sleep(Math.min(everyMs, Math.max(0, end - Date.now())));
    last = await bounded();
  }
  return last;
}
