import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

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
const args = { from: "SFO", to: "JFK", depart: "2026-11-13", adults: 2, miles: true };
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/miles.json", import.meta.url)));
function pageFor(data) {
  let reads = 0;
  return {
    async goto() {},
    async wait() {},
    async evaluate(fn) {
      if (typeof fn === "string" || fn.name !== "readDeltaPage") return true;
      return reads++ === 0
        ? { ...structuredClone(data), form_ready: true, rows: [] }
        : structuredClone(data);
    },
  };
}

test("registers a read-only persistent browser command with adapter-owned navigation", () => {
  assert.equal(command.site, "delta");
  assert.equal(command.name, "flights");
  assert.equal(command.strategy, "cookie");
  assert.equal(command.access, "read");
  assert.equal(command.siteSession, "persistent");
  assert.equal(command.browser, true);
  assert.equal(command.navigateBefore, false);
});

test("returns SkyMiles plus cash taxes and a separate card-member offer", async () => {
  const rows = await command.func(pageFor(fixture()), args);
  assert.equal(rows[0].miles, 33300);
  assert.equal(rows[0].taxes, 6);
  assert.equal(rows[0].card_member_miles, 28300);
});

for (const day of ["05", "5"]) {
  test(`returns awards when Delta displays Oct ${day}`, async () => {
    const data = fixture();
    data.search.segments[0].departure_date = "2026-10-05";
    data.date_heading = `Mon, Oct ${day}, 2026`;
    data.rows = [data.rows[0]];
    data.total = 1;
    const rows = await command.func(pageFor(data), { ...args, depart: "2026-10-05" });
    assert.ok(rows.length > 0);
    assert.equal(rows[0].departure_date, "2026-10-05");
    assert.equal(rows[0].miles, 33300);
    assert.equal(rows[0].taxes, 6);
  });
}

test("cash command does not require the miles flag or any account read", async () => {
  const data = fixture();
  data.search.award = "false";
  data.price_mode = "$USD";
  for (const row of data.rows)
    for (const fare of row.fares)
      if (fare.products.length) {
        Object.assign(fare, {
          cash_text: "$333",
          miles_text: "",
          taxes_text: "",
          promo_text: "",
          promo_label: "",
        });
      }
  assert.equal((await command.func(pageFor(data), { ...args, miles: false }))[0].price, 333);
});

test("invalid conditions fail before navigating", async () => {
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

test("missing browser and login-required errors remain actionable", async () => {
  await assert.rejects(command.func(null, args), /Browser session required/);
  await assert.rejects(
    command.func(pageFor({ ...fixture(), login_required: true }), args),
    (e) => e.constructor.name === "AuthRequiredError" && e.domain === "delta.com",
  );
});
