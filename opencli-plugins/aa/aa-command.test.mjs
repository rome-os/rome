import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { argsFor, fixture, mockPage } from "./test-fixtures.mjs";

const registryUrl = `data:text/javascript,${encodeURIComponent(`
export const Strategy={COOKIE:'cookie'};
export let command;
export function cli(definition){command=definition;}
`)}`;
const errorsUrl = `data:text/javascript,${encodeURIComponent(`
export class ArgumentError extends Error {}
export class CommandExecutionError extends Error {}
export class AuthRequiredError extends Error {constructor(domain,message){super(message);this.domain=domain;}}
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
const args = argsFor();
test("registers a read-only persistent browser command", () => {
  assert.equal(command.site, "aa");
  assert.equal(command.name, "flights");
  assert.equal(command.access, "read");
  assert.equal(command.strategy, "cookie");
  assert.equal(command.siteSession, "persistent");
  assert.equal(command.browser, true);
  assert.equal(command.navigateBefore, false);
  for (const name of ["miles", "max-miles", "return", "adults", "fare", "stops"])
    assert.ok(command.args.some((a) => a.name === name));
});
for (const mode of ["cash", "award", "round-cash", "round-award"])
  test(`executes ${mode}`, async () => {
    const rows = await command.func(mockPage([fixture(mode)]), argsFor(mode));
    assert.ok(rows.length > 0);
    assert.equal(rows[0].pricing, mode.includes("award") ? "miles" : "cash");
  });
test("bad arguments fail before navigation", async () => {
  const page = {
    async goto() {
      assert.fail("must not navigate");
    },
  };
  await assert.rejects(
    command.func(page, { ...args, depart: "2026-02-30" }),
    (e) => e.constructor.name === "ArgumentError",
  );
});
test("missing browser and provider failures are typed", async () => {
  await assert.rejects(command.func(null, args), /Browser session required/);
  await assert.rejects(
    command.func(mockPage([{ ...fixture(), challenge: true }]), args),
    (e) => e.constructor.name === "CommandExecutionError",
  );
  await assert.rejects(
    command.func(mockPage([{ ...fixture(), login_required: true }]), args),
    (e) => e.constructor.name === "AuthRequiredError" && e.domain === "aa.com",
  );
});
