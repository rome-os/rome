// The verifier's run on the product in the tree. It records results and never
// fails on a rule: run.sh reads the verdicts from the part it writes.

// First, so HOME is the sandbox's before any product module loads.
import "./sandbox.js";
import { it } from "@rstest/core";
import { runRule1b } from "./rule1.js";
import { runRule2 } from "./rule2.js";
import { writePart } from "./report.js";

it("scores the product on rules 1 and 2", async () => {
  const startedAt = Date.now();
  const rule1b = await runRule1b();
  const rule2 = await runRule2();
  writePart("core", { rule1b, rule2, elapsedMs: Date.now() - startedAt });
}, 300_000);
