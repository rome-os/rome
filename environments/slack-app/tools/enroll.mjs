// Enrolls one Rome instance in the environment's Rome Cloud and signs its
// guardian in, the way a person does it in a browser: Rome Cloud's dev sign-in
// for the account, then the instance's "Continue with Rome Cloud", the consent
// form, and the callback. The first sign-in creates the guardian seat and turns
// the Concierge on.
//
// Usage: node enroll.mjs <rome-cloud-origin> <instance-origin> <email> <out-cookies.json>
// Prints {"instanceId": ..., "guardian": ...} as JSON.

import { writeFileSync } from "node:fs";

const [cloud, instance, email, cookieFile] = process.argv.slice(2);
if (!cookieFile) {
  console.error(
    "usage: enroll.mjs <rome-cloud-origin> <instance-origin> <email> <out-cookies.json>",
  );
  process.exit(2);
}

// One cookie jar per origin, which is all this flow needs.
const jars = new Map();
const jarFor = (url) => {
  const key = new URL(url).host;
  if (!jars.has(key)) jars.set(key, new Map());
  return jars.get(key);
};

async function request(url, init = {}) {
  const jar = jarFor(url);
  const headers = new Headers(init.headers);
  if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const response = await fetch(url, { ...init, headers, redirect: "manual" });
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (/max-age=0/i.test(line) || value === "") jar.delete(name);
    else jar.set(name, value);
  }
  return response;
}

/** Follows redirects, carrying each origin's cookies, and returns the last response. */
async function follow(url, init = {}, trail = []) {
  let current = url;
  let response = await request(current, init);
  for (let hops = 0; hops < 20 && response.status >= 300 && response.status < 400; hops++) {
    current = new URL(response.headers.get("location"), current).toString();
    trail.push(current);
    response = await request(current);
  }
  return { response, url: current };
}

function fail(step, detail) {
  console.error(JSON.stringify({ error: `enroll failed at ${step}`, detail }));
  process.exit(1);
}

// 1. Sign in to Rome Cloud as the guardian's account.
const login = await follow(`${cloud}/api/auth/dev/start?email=${encodeURIComponent(email)}`);
if (login.response.status >= 400)
  fail("rome cloud sign-in", { status: login.response.status, url: login.url });

// 2. The instance starts its Rome Cloud sign-in.
const start = await request(`${instance}/api/auth/cloud/start`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: instance },
  body: "{}",
});
if (!start.ok) fail("instance start", { status: start.status, body: await start.text() });
const { authorizeUrl } = await start.json();

// 3. Rome Cloud shows the consent form for a device on a loopback address.
const consent = await follow(authorizeUrl);
const html = await consent.response.text();
let callback;
if (new URL(consent.url).origin === new URL(instance).origin) {
  callback = consent; // Rome Cloud approved without a form.
} else {
  const form = html.match(/<form[^>]*action="\/api\/oauth2\/authorize"[^>]*>([\s\S]*?)<\/form>/);
  if (!form)
    fail("consent form", {
      status: consent.response.status,
      url: consent.url,
      // What the page says, without its markup.
      text: html
        .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400),
    });
  const fields = new URLSearchParams();
  for (const input of form[1].matchAll(/<input[^>]*>/g)) {
    const name = input[0].match(/name="([^"]*)"/)?.[1];
    const value = input[0].match(/value="([^"]*)"/)?.[1] ?? "";
    if (name && /type="hidden"/.test(input[0])) fields.append(name, decodeEntities(value));
  }
  const approve = await request(`${cloud}/api/oauth2/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: cloud },
    body: fields,
  });
  if (approve.status < 300 || approve.status >= 400) {
    fail("consent approve", { status: approve.status, body: (await approve.text()).slice(0, 600) });
  }
  // 4. The callback on the instance redeems the code.
  callback = await follow(new URL(approve.headers.get("location"), cloud).toString());
}
const landed = new URL(callback.url);
if (callback.response.status >= 400 || landed.pathname.startsWith("/login")) {
  fail("instance callback", { status: callback.response.status, url: callback.url });
}

// 5. Prove it: the instance is enrolled, and the session is the guardian's.
// The enroll status route is public, so the identity check is what proves the
// session works.
const status = await request(`${instance}/api/instance/enroll/status`);
const enroll = status.ok ? await status.json() : null;
if (enroll?.enrolled !== true) fail("enroll status", { status: status.status, enroll });
const me = await request(`${instance}/api/auth/me`);
const identity = me.ok ? await me.json() : null;
if (identity?.kind !== "guardian") fail("guardian session", { status: me.status, identity });
writeFileSync(cookieFile, JSON.stringify(Object.fromEntries(jarFor(instance))), { mode: 0o600 });
console.log(JSON.stringify({ guardian: email, landed: landed.pathname, enroll, identity }));

function decodeEntities(s) {
  const named = {
    "&amp;": "&",
    "&quot;": '"',
    "&#x27;": "'",
    "&#39;": "'",
    "&lt;": "<",
    "&gt;": ">",
  };
  return s.replace(/&amp;|&quot;|&#x27;|&#39;|&lt;|&gt;/g, (m) => named[m]);
}
