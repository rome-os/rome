#!/usr/bin/env node
// verify [--rules 2,3] [--phase 1] [--place chrome] [--transcriber real|stand-in|<provider>]
//        [--dirty] [--voice-env "<command>"] [--reset "<command>"] [--script <dir>] [--out <dir>]
// Scores voice input against rules V2. With a provider as --transcriber, compares that
// provider on the script instead of scoring the product. See README.md.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compare, PROVIDERS } from "./lib/compare.mjs";
import { verify } from "./lib/runner.mjs";
import { loadScript } from "./lib/script.mjs";
import { voiceEnv } from "./lib/voice-env.mjs";

const here = import.meta.dirname;

const { values } = parseArgs({
  options: {
    rules: { type: "string" },
    phase: { type: "string" },
    place: { type: "string", default: "chrome" },
    transcriber: { type: "string", default: "real" },
    dirty: { type: "boolean", default: false },
    "voice-env": { type: "string", default: join(here, "..", "voice-env") },
    reset: { type: "string", default: `${join(here, "..", "env.sh")} reset` },
    script: { type: "string" },
    out: { type: "string" },
    "runs-dir": { type: "string" },
    "after-speech": { type: "string", default: "4" },
    "send-check": { type: "string", default: "60" },
    "send-wait": { type: "string", default: "10" },
    steady: { type: "string", default: "1.5" },
    secrets: { type: "string", default: join(homedir(), ".config/rome/voice.env") },
  },
});

/** Sets each `NAME=value` line of `file` that the environment does not already set. */
function loadSecrets(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined)
      process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
}

const ms = (s) => Math.round(Number(s) * 1000);
const log = (line) => process.stderr.write(`${line}\n`);
const rules = values.rules?.split(",").map((r) => r.trim());

try {
  const script = loadScript(values.script);
  if (PROVIDERS[values.transcriber]) {
    loadSecrets(values.secrets);
    const { outDir } = await compare({
      provider: values.transcriber,
      script,
      rules: rules ?? ["2", "3"],
      runsDir: values["runs-dir"],
      outDir: values.out,
      log,
    });
    console.log(`report: ${join(outDir, "report.md")}`);
    process.exit(0);
  }
  if (!["real", "stand-in"].includes(values.transcriber)) {
    throw new Error(
      `--transcriber is real, stand-in, or one of ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  const { report, outDir } = await verify({
    env: voiceEnv({
      command: values["voice-env"].split(" ").filter(Boolean),
      resetCommand: values.reset ? values.reset.split(" ").filter(Boolean) : undefined,
    }),
    script,
    rules,
    phase: values.phase ? Number(values.phase) : undefined,
    place: values.place,
    transcriber: values.transcriber,
    waits: {
      afterSpeechMs: ms(values["after-speech"]),
      sendCheckMs: ms(values["send-check"]),
      sendMs: ms(values["send-wait"]),
      steadyMs: ms(values.steady),
    },
    allowDirty: values.dirty,
    runsDir: values["runs-dir"],
    outDir: values.out,
    log,
  });
  for (const r of report.results)
    console.log(`${r.rule}\t${r.status}${r.partial ? " (partly checked)" : ""}\t${r.reason}`);
  console.log(`report: ${join(outDir, "report.md")}`);
  process.exit(report.summary.fail > 0 ? 1 : 0);
} catch (error) {
  console.error(`verify: ${error.message}`);
  process.exit(2);
}
