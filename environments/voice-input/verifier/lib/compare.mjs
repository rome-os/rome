// The provider comparison: plays each script recording straight to one provider, without the
// product, and scores it the way rules 2 and 3 score the product.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BAR_SECONDS } from "../scenarios/r2-text-as-you-speak.mjs";
import { BAR_PER_100 } from "../scenarios/r3-what-you-said.mjs";
import { PROVIDERS } from "./providers.mjs";
import { DEFAULT_RUNS_DIR } from "./runner.mjs";
import { errors, per100 } from "./text.mjs";

export { PROVIDERS };

const CHUNK_SECONDS = 0.1;

/** Mono 16-bit samples and their rate from a PCM WAV file. */
export function readWav(buffer) {
  let offset = 12;
  let rate = 0;
  while (offset < buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") rate = buffer.readUInt32LE(offset + 12);
    if (id === "data") {
      const data = buffer.subarray(offset + 8, offset + 8 + size);
      const samples = new Int16Array(data.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
      return { samples, rate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}

/** Down-samples by a whole factor, averaging each block. */
export function resample(samples, from, to) {
  if (from === to) return samples;
  const factor = from / to;
  if (!Number.isInteger(factor)) throw new Error(`cannot resample ${from} Hz to ${to} Hz`);
  const out = new Int16Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += samples[i * factor + j];
    out[i] = Math.round(sum / factor);
  }
  return out;
}

/**
 * Streams `samples` at real time divided by `speed` and resolves to `{ text, firstTextAt,
 * completeAt }`, times in seconds of audio from the first chunk. `null` times mean no text.
 */
export async function stream(
  provider,
  { key, language, samples, speed = 1, endTimeoutMs = 20000 },
) {
  const started = Date.now();
  const at = () => ((Date.now() - started) / 1000) * speed;
  let text = "";
  let firstTextAt = null;
  let completeAt = null;
  const session = await provider.connect({
    key,
    language,
    onText: (now) => {
      if (now === text) return;
      text = now;
      firstTextAt ??= at();
      completeAt = at();
    },
  });
  const step = Math.round(provider.rate * CHUNK_SECONDS);
  for (let i = 0; i < samples.length; i += step) {
    session.send(samples.slice(i, i + step));
    const due = ((i + step) / provider.rate / speed) * 1000;
    await new Promise((r) => setTimeout(r, Math.max(0, started + due - Date.now())));
  }
  session.end();
  await Promise.race([session.done, new Promise((r) => setTimeout(r, endTimeoutMs))]);
  return { text, firstTextAt, completeAt };
}

/**
 * Scores `provider` on the script and writes report.json and report.md. A missing credential
 * or a failed message is reported, not thrown. Resolves to `{ report, outDir }`.
 */
export async function compare({
  provider: name,
  script,
  rules = ["2", "3"],
  runsDir,
  outDir,
  log,
  speed,
}) {
  const provider = PROVIDERS[name];
  const key = process.env[provider.keyVar];
  const startedAt = new Date();
  const dir =
    outDir ??
    join(
      runsDir ?? DEFAULT_RUNS_DIR,
      `${startedAt.toISOString().replace(/[:.]/g, "-")}-compare-${name}`,
    );
  mkdirSync(dir, { recursive: true });
  const results = [];
  if (key) {
    for (const message of script.messages) {
      results.push(await scoreMessage(provider, key, message, speed));
      log(`${name} ${message.key}: ${results.at(-1).error ?? "done"}`);
    }
  }
  const report = {
    provider: name,
    providerName: provider.name,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    rules,
    notChecked: key ? null : `no provider credential: set ${provider.keyVar}`,
    pricePerHour: provider.pricePerHour,
    languages: key ? summarize(results, provider) : [],
    results,
  };
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), renderComparison(report));
  return { report, outDir: dir };
}

async function scoreMessage(provider, key, message, speed) {
  const base = { key: message.key, language: message.language, set: message.set ?? "A" };
  try {
    const wav = readFileSync(message.path);
    const heard = provider.file
      ? { text: await provider.transcribe({ key, wav }), firstTextAt: null, completeAt: null }
      : await stream(provider, {
          key,
          language: message.language,
          speed,
          samples: (({ samples, rate }) => resample(samples, rate, provider.rate))(readWav(wav)),
        });
    return {
      ...base,
      heard: heard.text,
      ...errors(message.text, heard.text, message.language),
      firstDelay: heard.firstTextAt === null ? null : heard.firstTextAt - message.firstWordAt,
      completeDelay: heard.completeAt === null ? null : heard.completeAt - message.lastWordAt,
    };
  } catch (error) {
    return { ...base, error: error.message };
  }
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return s.length === 0 ? null : Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
};

function summarize(results, provider) {
  const groups = [
    ["English", ["en"]],
    ["Mandarin", ["zh"]],
    ["Mandarin mixed with English", ["mixed"]],
    ["Mandarin and mixed (rule 3 pool)", ["zh", "mixed"]],
  ];
  const sets = [...new Set(results.map((r) => r.set))].sort();
  return sets.flatMap((set) =>
    groups.map(([group, langs]) => {
      const label = `set ${set}, ${group}`;
      const inSet = results.filter((r) => r.set === set);
      const pool = inSet.filter((r) => langs.includes(r.language) && !r.error);
      const within = pool.filter(
        (r) =>
          r.firstDelay !== null && r.firstDelay <= BAR_SECONDS && r.completeDelay <= BAR_SECONDS,
      ).length;
      return {
        label,
        messages: pool.length,
        failed: inSet.filter((r) => langs.includes(r.language) && r.error).length,
        wrongPer100: per100(pool),
        medianFirstDelay: provider.file ? null : median(pool.map((r) => r.firstDelay)),
        medianCompleteDelay: provider.file ? null : median(pool.map((r) => r.completeDelay)),
        withinRule2Bar: provider.file ? null : within,
      };
    }),
  );
}

function renderComparison(report) {
  const dash = (v, unit = "") => (v === null || v === undefined ? "–" : `${v}${unit}`);
  const price = report.pricePerHour;
  const lines = [
    `# Transcriber comparison: ${report.providerName}, ${report.startedAt}`,
    "",
    `Price per hour: ${price.usd === null ? "unknown" : `$${price.usd}`} (${price.source}). Bars: rule 3 at most ${BAR_PER_100} wrong in 100; rule 2 first and complete text within ${BAR_SECONDS} s.`,
  ];
  if (report.notChecked) {
    lines.push("", `Not checked: ${report.notChecked}.`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "",
    "| Set and language | Messages | Wrong in 100 | Median delay to first text | Median delay to complete text | Within rule 2 bar |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const l of report.languages) {
    lines.push(
      `| ${l.label} | ${l.messages}${l.failed ? ` (${l.failed} failed)` : ""} | ${dash(l.wrongPer100)} | ${dash(l.medianFirstDelay, " s")} | ${dash(l.medianCompleteDelay, " s")} | ${l.withinRule2Bar === null ? "–" : `${l.withinRule2Bar} of ${l.messages}`} |`,
    );
  }
  lines.push("", "## Messages", "");
  for (const r of report.results) {
    lines.push(
      r.error
        ? `- **${r.key}**: failed: ${r.error}`
        : `- **${r.key}**: ${r.wrong} wrong of ${r.of}; first text ${dash(r.firstDelay?.toFixed(2), " s")}, complete ${dash(r.completeDelay?.toFixed(2), " s")}; heard "${r.heard}"`,
    );
  }
  return `${lines.join("\n")}\n`;
}
