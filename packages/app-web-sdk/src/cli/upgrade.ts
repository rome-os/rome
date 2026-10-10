import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { findAppDir } from "./loadAppYaml.js";
import { CliError } from "./store/config.js";

const HELP = `Usage: rome upgrade <major|minor|patch> [directory]

  <major|minor|patch>   Version segment to increment.
  [directory]           App directory, or a child directory inside one.
                        Defaults to the current working directory.
  --help, -h            Show this help.`;

const RELEASE_TYPES = ["major", "minor", "patch"] as const;

export type VersionReleaseType = (typeof RELEASE_TYPES)[number];

export interface UpgradeAppVersionResult {
  manifestPath: string;
  previousVersion: string;
  version: string;
}

export async function runUpgrade(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (positionals.length === 0) {
    process.stdout.write(`${HELP}\n`);
    process.exitCode = 1;
    return;
  }
  if (positionals.length > 2) {
    throw new CliError(
      `rome upgrade: unexpected argument(s): ${positionals.slice(2).join(" ")}`,
      2,
    );
  }

  const release = parseReleaseType(positionals[0]);
  const startDir = path.resolve(positionals[1] ?? process.cwd());
  const result = await upgradeAppVersion(startDir, release);

  process.stdout.write(
    `Updated ${result.manifestPath}: ${result.previousVersion} -> ${result.version}\n`,
  );
}

export async function upgradeAppVersion(
  startDir: string,
  release: VersionReleaseType,
): Promise<UpgradeAppVersionResult> {
  const manifestPath = await findManifestPath(startDir);
  const raw = await fs.readFile(manifestPath, "utf8");
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new CliError(
      `Failed to parse app manifest ${manifestPath}: ${doc.errors[0]?.message ?? "invalid YAML"}`,
    );
  }

  const previousVersion = doc.get("version");
  if (typeof previousVersion !== "string") {
    throw new CliError(`app.yaml is missing string field \`version\``);
  }

  const version = bumpVersion(previousVersion, release);
  doc.set("version", version);
  await fs.writeFile(manifestPath, doc.toString(), "utf8");

  return { manifestPath, previousVersion, version };
}

export function bumpVersion(version: string, release: VersionReleaseType): string {
  const parsed = parseSemver(version);

  switch (release) {
    case "major":
      return `${parsed.major + 1}.0.0`;
    case "minor":
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case "patch":
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
}

function parseReleaseType(input: string): VersionReleaseType {
  if (RELEASE_TYPES.includes(input as VersionReleaseType)) {
    return input as VersionReleaseType;
  }
  throw new CliError(
    `rome upgrade: expected major, minor, or patch; got ${JSON.stringify(input)}`,
    2,
  );
}

async function findManifestPath(startDir: string): Promise<string> {
  const appDir = findAppDir(await resolveDirectory(startDir));
  if (!appDir) {
    throw new CliError(`rome upgrade: could not locate app.yaml searching upward from ${startDir}`);
  }
  return path.join(appDir, "app.yaml");
}

async function resolveDirectory(inputPath: string): Promise<string> {
  const stat = await fs.stat(inputPath).catch(() => null);
  if (!stat) {
    throw new CliError(`rome upgrade: ${inputPath} does not exist`);
  }
  if (stat.isDirectory()) return inputPath;
  if (stat.isFile()) return path.dirname(inputPath);
  throw new CliError(`rome upgrade: ${inputPath} is not a directory`);
}

function parseSemver(version: string): { major: number; minor: number; patch: number } {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) {
    throw new CliError(
      `app.yaml version must be SemVer, for example 1.2.3; got ${JSON.stringify(version)}`,
    );
  }

  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}
