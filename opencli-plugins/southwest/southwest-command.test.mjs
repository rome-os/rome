import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { fixture, mockPage } from "./test-fixtures.mjs";

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
const args = { from: "OAK", to: "HOU", depart: "2026-11-13" };
test("registers a read-only persistent browser command with explicit navigation", () => {
  assert.equal(command.site, "southwest");
  assert.equal(command.name, "flights");
  assert.equal(command.access, "read");
  assert.equal(command.strategy, "cookie");
  assert.equal(command.siteSession, "persistent");
  assert.equal(command.browser, true);
  assert.equal(command.navigateBefore, false);
  for (const name of [
    "miles",
    "points",
    "max-miles",
    "max-points",
    "return",
    "adults",
    "fare",
    "stops",
  ])
    assert.ok(command.args.some((a) => a.name === name));
});
for (const alias of ["miles", "points"])
  test(`--${alias} executes the award path`, async () => {
    const rows = await command.func(mockPage([fixture()]), { ...args, [alias]: true, adults: 2 });
    assert.equal(rows[0].points, 13500);
    assert.equal(rows[0].price, null);
    assert.equal(rows[0].taxes, 5.6);
  });
test("cash round-trip search returns per-direction prices rather than a combined ticket", async () => {
  const rows = await command.func(mockPage([fixture("cash")]), { ...args, return: "2026-11-20" });
  assert.equal(rows[0].price, 200);
  assert.equal(rows[0].result_type, "outbound_option");
  assert.equal(rows[0].price_basis, "per_person_each_way");
});
test("bad search arguments fail before navigation", async () => {
  const p = {
    async goto() {
      assert.fail("must not navigate");
    },
  };
  await assert.rejects(
    command.func(p, { ...args, depart: "2026-02-30" }),
    (e) => e.constructor.name === "ArgumentError",
  );
});
test("missing browser and provider failures are actionable typed errors", async () => {
  await assert.rejects(command.func(null, args), /Browser session required/);
  await assert.rejects(
    command.func(mockPage([{ ...fixture(), challenge: true }]), args),
    (e) => e.constructor.name === "CommandExecutionError",
  );
  await assert.rejects(
    command.func(mockPage([{ ...fixture(), login_required: true }]), args),
    (e) => e.constructor.name === "AuthRequiredError" && e.domain === "southwest.com",
  );
});
