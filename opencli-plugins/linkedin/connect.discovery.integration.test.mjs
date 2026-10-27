import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { getRegistry } from "@jackwener/opencli/registry";

const require = createRequire(import.meta.url);
const registryEntry = require.resolve("@jackwener/opencli/registry");
const opencliRoot = resolve(dirname(registryEntry), "..", "..");
const { discoverClis } = await import(
  pathToFileURL(join(opencliRoot, "dist/src/discovery.js")).href
);

await discoverClis(join(opencliRoot, "clis"));

const registry = getRegistry();
const lazyConnect = registry.get("linkedin/connect");
const lazySentInvitations = registry.get("linkedin/sent-invitations");
assert.equal(lazyConnect?._lazy, true);
assert.equal(lazyConnect?.func, undefined);
assert.equal(lazySentInvitations?._lazy, true);
assert.equal(lazySentInvitations?.func, undefined);

await import("./connect.js");

test("the Rome override loads after manifest discovery registers lazy commands", () => {
  const connect = registry.get("linkedin/connect");
  const sentInvitations = registry.get("linkedin/sent-invitations");

  assert.notEqual(connect, lazyConnect);
  assert.equal(typeof connect?.func, "function");
  assert.equal(connect?._lazy, undefined);
  assert.equal(typeof sentInvitations?.func, "function");
  assert.equal(sentInvitations?._lazy, undefined);
});
