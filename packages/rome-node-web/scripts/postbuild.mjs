import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist/web");
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json"]);
// Guardrail so accidental heavy dependencies (charts, markdown, icon packs) fail CI immediately.
const MAX_TOTAL_GZIP_BYTES = 160 * 1024;

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (entry.isFile() && !entry.name.endsWith(".gz")) results.push(full);
  }
  return results.sort();
}

const files = walk(distDir);
let totalRaw = 0;
let totalGzip = 0;

for (const file of files) {
  const raw = readFileSync(file);
  const rawBytes = raw.byteLength;
  totalRaw += rawBytes;
  if (COMPRESSIBLE.has(extname(file).toLowerCase())) {
    const compressed = gzipSync(raw, { level: 9 });
    writeFileSync(`${file}.gz`, compressed);
    totalGzip += compressed.byteLength;
    console.log(
      `${relative(distDir, file).padEnd(42)} ${(rawBytes / 1024).toFixed(1).padStart(7)} KiB  (gzip ${(compressed.byteLength / 1024).toFixed(1).padStart(6)} KiB)`,
    );
  } else {
    totalGzip += statSync(file).size;
    console.log(
      `${relative(distDir, file).padEnd(42)} ${(rawBytes / 1024).toFixed(1).padStart(7)} KiB`,
    );
  }
}

console.log(
  `Total: ${(totalRaw / 1024).toFixed(1)} KiB raw, ${(totalGzip / 1024).toFixed(1)} KiB gzip (budget ${(MAX_TOTAL_GZIP_BYTES / 1024).toFixed(0)} KiB)`,
);

if (totalGzip > MAX_TOTAL_GZIP_BYTES) {
  console.error(`Bundle size budget exceeded: ${totalGzip} bytes > ${MAX_TOTAL_GZIP_BYTES} bytes.`);
  process.exitCode = 1;
}
