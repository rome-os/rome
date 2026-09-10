import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

const registryUrl = `data:text/javascript,${encodeURIComponent(`
  export const Strategy = { PUBLIC: "public", COOKIE: "cookie" };
  export let command;
  export function cli(definition) { command = definition; }
`)}`;
const errorsUrl = `data:text/javascript,${encodeURIComponent(`
  export class ArgumentError extends Error {}
  export class CommandExecutionError extends Error {}
  export class AuthRequiredError extends Error {
    constructor(domain, message) { super(message); this.domain = domain; }
  }
`)}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@jackwener/opencli/registry")
      return { url: registryUrl, shortCircuit: true };
    if (specifier === "@jackwener/opencli/errors") return { url: errorsUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
let command;
try {
  await import("./flights.js");
  ({ command } = await import(registryUrl));
} finally {
  hooks.deregister();
}

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const args = { from: "SFO", to: "IAH", depart: "2026-11-13", return: "2026-11-15" };
const pageFor = (data) => ({
  async goto() {},
  async wait() {},
  async evaluate() {
    return structuredClone(data);
  },
});

test("command declares a persistent cookie-backed browser session with adapter-owned navigation", () => {
  assert.equal(command.strategy, "cookie");
  assert.equal(command.siteSession, "persistent");
  assert.equal(command.browser, true);
  assert.equal(command.navigateBefore, false);
  assert.equal(command.access, "read");
});

test("cookie-backed command still permits anonymous cash search", async () => {
  const rows = await command.func(pageFor(fixture("cash")), { ...args, adults: 2 });
  assert.equal(rows[0].pricing, "money");
  assert.equal(rows[0].price, 454);
});

test("signed-out awards still report United authentication rather than cash fallback", async () => {
  await assert.rejects(
    command.func(pageFor({ ...fixture("miles"), login_required: true }), { ...args, miles: true }),
    (error) => error.constructor.name === "AuthRequiredError" && error.domain === "united.com",
  );
});
