// The verifier against the stand-in product: the good variant passes every phase 1 rule, and
// each failing variant fails its own rule.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startStandIn, VARIANTS } from "../fake/server.mjs";
import { emptyState } from "../fake/state.mjs";
import { verify } from "../lib/runner.mjs";
import { loadScript } from "../lib/script.mjs";
import { voiceEnv } from "../lib/voice-env.mjs";
import { execFileSync } from "node:child_process";

const fakeEnv = fileURLToPath(new URL("../fake/voice-env.mjs", import.meta.url));

/** Every test folder, so their Chromes die even when a test times out or the run is killed. */
const testDirs = [];
function killChromes() {
  for (const dir of testDirs) {
    try {
      execFileSync("pkill", ["-KILL", "-f", `--user-data-dir=${dir}`]);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}
process.on("exit", killChromes);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    killChromes();
    process.exit(1);
  });
}
const PHASE_1 = ["2", "3", "5", "6", "10", "11"];

/**
 * A short copy of the script: per set, two English, one Mandarin and one mixed message, with
 * the real written text and 0.4 s of speech each.
 */
function shortScript(dir) {
  const real = loadScript(fileURLToPath(new URL("../script", import.meta.url)));
  const keep = /^(b-)?(en-[12]|zh-1|mixed-1)$/;
  const messages = real.messages
    .filter((m) => keep.test(m.key))
    .map((m) => ({ ...m, firstWordAt: 0.2, lastWordAt: 0.6 }));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ sources: real.sources, messages }));
  return loadScript(dir);
}

const WAITS = { afterSpeechMs: 2200, sendCheckMs: 300, sendMs: 3000, steadyMs: 300 };

async function runAgainst(variant, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), `voice-verify-${variant}-`));
  testDirs.push(dir);
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify(emptyState(variant)));
  const script = shortScript(dir);
  const standIn = await startStandIn({ statePath, script });
  const env = { ...process.env, VOICE_FAKE_STATE: statePath, VOICE_FAKE_URL: standIn.url };
  try {
    return await verify({
      env: voiceEnv({
        command: ["node", fakeEnv],
        resetCommand: ["node", fakeEnv, "reset"],
        env,
      }),
      script,
      waits: WAITS,
      allowDirty: true,
      outDir: join(dir, "run"),
      log: process.env.VERIFY_TEST_LOG ? (line) => console.error(`${variant}: ${line}`) : () => {},
      ...options,
    });
  } finally {
    // No Chrome or profile outlives the test, whatever the verifier did.
    execFileSync("node", [fakeEnv, "browser", "stop"], { env });
    try {
      execFileSync("pkill", ["-KILL", "-f", `--user-data-dir=${dir}`]);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    await standIn.close();
  }
}

const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.rule, r.status]));

describe("verify against the stand-in product", { concurrency: 3, timeout: 480000 }, () => {
  for (const variant of VARIANTS) {
    it(`scores ${variant}`, async () => {
      const { report } = await runAgainst(variant);
      const broken = variant === "good" ? [] : [variant.slice("fail-".length).replace(/\D+$/, "")];
      assert.deepEqual(
        statuses(report),
        Object.fromEntries(PHASE_1.map((r) => [r, broken.includes(r) ? "fail" : "pass"])),
        JSON.stringify(
          report.results.map((r) => [r.rule, r.reason]),
          null,
          1,
        ),
      );
    });
  }

  it("leaves rules 2 and 3 not checked on the stand-in transcriber", async () => {
    const { report } = await runAgainst("good", { transcriber: "stand-in" });
    assert.deepEqual(
      statuses(report),
      {
        2: "not_checked",
        3: "not_checked",
        5: "pass",
        6: "pass",
        10: "pass",
        11: "pass",
      },
      JSON.stringify(report.results.map((r) => [r.rule, r.reason])),
    );
  });
});
