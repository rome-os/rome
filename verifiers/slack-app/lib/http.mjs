// HTTP helpers for the verifier: JSON calls and a small browser that follows
// redirects and reads HTML forms, enough to walk a sign-in.

/** Calls `url` and parses a JSON answer. Never throws on a non-2xx status. */
export async function json(url, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

/**
 * Follows redirects by hand from `url` and stops at the first answer that is
 * not a redirect, or at the first URL `stopAt` accepts. Returns every URL
 * visited, so a caller can show the path the sign-in took.
 */
export async function follow(url, { method = "GET", form, stopAt = () => false, max = 15 } = {}) {
  const visited = [];
  let next = url;
  let nextMethod = method;
  let nextBody = form ? new URLSearchParams(form).toString() : undefined;
  for (let i = 0; i < max; i++) {
    visited.push(next);
    if (stopAt(new URL(next))) return { stoppedAt: new URL(next), visited };
    const res = await fetch(next, {
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
    return { status: res.status, url: new URL(next), html: await res.text(), visited };
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
 * returns the last value either way.
 */
export async function waitFor(probe, { timeoutMs, everyMs = 500 }) {
  const end = Date.now() + timeoutMs;
  let last = await probe();
  while (!last && Date.now() < end) {
    await sleep(everyMs);
    last = await probe();
  }
  return last;
}
