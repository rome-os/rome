import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isBlockedSourceFile,
  isExcludedSourceEntry,
  SOURCE_EXCLUDED_SEGMENTS,
} from "@rome-os/app-runtime/packaging";
import { create as tarCreate } from "tar";
import YAML from "yaml";
import { CliError, requireBearer } from "./config.js";
import { postMultipart } from "./api.js";

const HELP = `Usage: rome publish <directory>

  <directory>            Path to the app directory (must contain app.yaml).
  --dry-run              Package and compute hash, but don't upload.
  --out <file>           Also write the tarball to <file>.
  --exclude <pattern>    Skip files/dirs whose path segment matches <pattern>.
                         Repeatable. Defaults: node_modules, .git, .DS_Store.
                         .rome and .rome_store are always excluded.
  --no-default-exclude   Don't apply the built-in default excludes.
  --help, -h             Show this help.`;

const DEFAULT_EXCLUDES = ["node_modules", ".git", ".DS_Store"];
const ALWAYS_EXCLUDES = [".rome", ".rome_store"];
interface PublishResponse {
  listing: { id: string; handle: string; slug: string };
  version: { version: string; contentHash: string; sizeBytes: number; sourceAvailable?: boolean };
  claimed: boolean;
}

export async function runPublish(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      out: { type: "string" },
      exclude: { type: "string", multiple: true },
      "no-default-exclude": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(`${HELP}\n`);
    if (positionals.length === 0 && !values.help) process.exitCode = 1;
    return;
  }

  const dir = path.resolve(positionals[0]);
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new CliError(`${dir} is not a directory`);
  }

  const manifestPath = path.join(dir, "app.yaml");
  const manifestRaw = await fs.readFile(manifestPath, "utf8").catch(() => {
    throw new CliError(`${manifestPath} not found`);
  });
  const manifest = YAML.parse(manifestRaw) as unknown;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new CliError("app.yaml must be a YAML mapping");
  }
  const manifestObject = manifest as Record<string, unknown>;
  const id = typeof manifestObject.id === "string" ? manifestObject.id : "";
  const version = typeof manifestObject.version === "string" ? manifestObject.version : "";
  if (!id) throw new CliError("app.yaml is missing `id`");
  if (!version) throw new CliError("app.yaml is missing `version`");
  if (
    manifestObject.includeSource !== undefined &&
    typeof manifestObject.includeSource !== "boolean"
  ) {
    throw new CliError("app.yaml `includeSource` must be a boolean");
  }
  const includeSource = manifestObject.includeSource === true;

  // Package as a single-rooted tarball: parentDir/<dirName>/...
  // This matches the manifest extractor's "single-rooted layout" path.
  const parentDir = path.dirname(dir);
  const dirName = path.basename(dir);

  const excludes = new Set<string>(values["no-default-exclude"] ? [] : DEFAULT_EXCLUDES);
  for (const pattern of ALWAYS_EXCLUDES) excludes.add(pattern);
  for (const pattern of values.exclude ?? []) excludes.add(pattern);
  if (includeSource) {
    if (excludes.has("src")) {
      throw new CliError("app.yaml enables includeSource, so --exclude src is not allowed");
    }
    await validatePublishedSource(path.join(dir, "src"));
    for (const pattern of SOURCE_EXCLUDED_SEGMENTS) excludes.add(pattern);
  }

  const bytes = await packDirectory(parentDir, dirName, excludes, includeSource);
  const hash = createHash("sha256").update(bytes).digest("hex");

  process.stdout.write(
    `Packaged ${id}@${version} — ${bytes.length} bytes, sha256 ${hash}, sourceAvailable ${includeSource}\n`,
  );

  const storeRoot = await findStoreRoot(dir);
  const storeBytes = storeRoot
    ? await packDirectory(path.dirname(storeRoot), path.basename(storeRoot))
    : null;
  if (storeBytes) {
    const storeHash = createHash("sha256").update(storeBytes).digest("hex");
    process.stdout.write(
      `Included store metadata sidecar from ${storeRoot} — ${storeBytes.length} bytes, sha256 ${storeHash}\n`,
    );
  }

  if (values.out) {
    const outPath = path.resolve(values.out);
    await fs.writeFile(outPath, bytes);
    process.stdout.write(`Wrote tarball to ${outPath}\n`);
  }

  if (values["dry-run"]) {
    process.stdout.write("Dry run — skipping upload.\n");
    return;
  }

  const bearer = await requireBearer();
  const form = new FormData();
  form.set(
    "bundle",
    new Blob([toBlobPart(bytes)], { type: "application/gzip" }),
    `${id}-${version}.tgz`,
  );
  if (storeBytes) {
    form.set(
      "store",
      new Blob([toBlobPart(storeBytes)], { type: "application/gzip" }),
      "rome_store.tgz",
    );
  }

  const result = await postMultipart<PublishResponse>(
    bearer.host,
    "/api/store/publish",
    form,
    { "x-bundle-sha256": hash },
    bearer,
  );

  process.stdout.write(
    `Published ${result.listing.id} @ ${result.version.version}${
      result.claimed ? ` (claimed handle @${result.listing.handle})` : ""
    }\n`,
  );
}

async function validatePublishedSource(sourceDir: string): Promise<void> {
  const sourceStat = await fs.lstat(sourceDir).catch(() => null);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new CliError(
      `app.yaml enables includeSource, but ${sourceDir} is not a regular directory`,
    );
  }
  await validatePublishedSourceTree(sourceDir, sourceDir);
}

async function validatePublishedSourceTree(sourceRoot: string, currentDir: string): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (isExcludedSourceEntry(entry.name)) continue;

    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(sourceRoot, absolutePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new CliError(
        `Cannot publish source file ${relativePath}: symbolic links are not allowed in src/`,
      );
    }
    if (stat.isDirectory()) {
      await validatePublishedSourceTree(sourceRoot, absolutePath);
      continue;
    }
    if (!stat.isFile() || stat.nlink > 1) {
      throw new CliError(
        `Cannot publish source file ${relativePath}: only regular, non-linked files are allowed in src/`,
      );
    }
    if (isBlockedSourceFile(entry.name)) {
      throw new CliError(
        `Cannot publish source file ${relativePath}: secret files are not allowed in src/`,
      );
    }
  }
}

async function packDirectory(
  parentDir: string,
  dirName: string,
  excludes: ReadonlySet<string> = new Set(),
  includeRootSource = true,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = tarCreate(
    {
      gzip: true,
      cwd: parentDir,
      portable: true,
      // Strip mtime/uid/gid variability so the same source produces the same
      // bytes, and therefore the same contentHash, across machines and runs.
      noMtime: true,
      // tar emits paths with forward slashes regardless of platform.
      filter: (entryPath) => {
        const segments = entryPath.split("/").filter(Boolean);
        if (!includeRootSource && segments[0] === dirName && segments[1] === "src") return false;
        return !segments.some((segment) => excludes.has(segment));
      },
    },
    [dirName],
  );
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return Buffer.concat(chunks);
}

async function findStoreRoot(publishDir: string): Promise<string | null> {
  const candidates = [path.join(publishDir, ".rome_store")];
  const sourceRoot = sourceRootForArtifactPath(publishDir);
  if (sourceRoot) candidates.unshift(path.join(sourceRoot, ".rome_store"));

  for (const candidate of candidates) {
    const manifest = path.join(candidate, "rome_store.yaml");
    const stat = await fs.stat(manifest).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
}

function sourceRootForArtifactPath(publishDir: string): string | null {
  const normalized = path.resolve(publishDir);
  if (path.basename(normalized) !== "artifact") return null;
  const romeDir = path.dirname(normalized);
  if (path.basename(romeDir) !== ".rome") return null;
  return path.dirname(romeDir);
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
