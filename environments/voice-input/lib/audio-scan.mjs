// Searches an instance for audio: its profile folder, database files and
// logs. Runs inside Rome's container (copied in by voice-env, and removed
// after). Prints JSON: the roots searched, how many files, and each finding.
//
//   node audio-scan.mjs <root>...   (container logs come on stdin)
//
// A file is a finding when it has an audio extension, starts with an audio
// signature, or holds an audio signature or base64 audio anywhere in it.
// Raw PCM has no signature, so a raw PCM dump is found only by its extension.
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { extname, join } from "node:path";
import { base64AudioIn, signatureAt } from "./audio.mjs";

const AUDIO_EXTENSIONS = new Set([
  ".wav",
  ".wave",
  ".ogg",
  ".oga",
  ".opus",
  ".webm",
  ".weba",
  ".mp3",
  ".m4a",
  ".aac",
  ".flac",
  ".pcm",
  ".raw",
  ".caf",
  ".amr",
]);
const MAX_FILE = 512 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;
const SELF = "/tmp/voice-env-scan";
const EMBEDDED = [
  ["RIFF/WAVE", /RIFF[\s\S]{4}WAVE/],
  ["Ogg", /OggS\x00/],
  ["WebM/Matroska", /\x1aE\xdf\xa3[\s\S]{0,40}webm/],
  ["FLAC", /fLaC\x00/],
];

const findings = [];
let files = 0;
let bytes = 0;

function scanFile(path, size) {
  files++;
  bytes += size;
  const reasons = [];
  const ext = extname(path).toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) reasons.push(`extension ${ext}`);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, CHUNK) + 64);
    let carry = Buffer.alloc(0);
    for (let at = 0; at < size; at += CHUNK) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - at), at);
      const chunk = Buffer.concat([carry, buf.subarray(0, n)]);
      if (at === 0) {
        const sig = signatureAt(chunk);
        if (sig && sig !== "AAC (ADTS)") reasons.push(`starts with ${sig}`);
      }
      const text = chunk.toString("latin1");
      for (const [name, re] of EMBEDDED) {
        const m = re.exec(text);
        if (m && !(at === 0 && m.index === 0))
          reasons.push(`${name} at byte ${at - carry.length + m.index}`);
      }
      const b64 = base64AudioIn(text);
      if (b64) reasons.push(`base64 ${b64}`);
      carry = chunk.subarray(Math.max(0, chunk.length - 512));
      if (reasons.length >= 3) break;
    }
  } finally {
    closeSync(fd);
  }
  if (reasons.length) findings.push({ path, size, reasons: [...new Set(reasons)] });
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (path === SELF) continue;
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path);
    else if (st.isFile() && st.size > 0 && st.size <= MAX_FILE) {
      try {
        scanFile(path, st.size);
      } catch {}
    }
  }
}

const roots = process.argv.slice(2);
for (const root of roots) walk(root);

let logs = "";
for await (const chunk of process.stdin) logs += chunk.toString("latin1");
const logFinding = base64AudioIn(logs) ?? EMBEDDED.find(([, re]) => re.test(logs))?.[0];
if (logFinding)
  findings.push({ path: "(container logs)", size: logs.length, reasons: [logFinding] });

console.log(
  JSON.stringify({ roots: [...roots, "(container logs)"], files, bytes, findings }, null, 2),
);
