import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appIdToDisplayName,
  isDirectoryNonEmpty,
  isValidAppId,
  materializeTemplate,
} from "@rome-os/app-runtime/packaging";
import { CliError } from "./store/config.js";

const HELP = `rome create — scaffold a new Rome app from the template

Usage: rome create <app-id> [--dir <path>] [--name "<Display Name>"]

  <app-id>   lowercase slug, e.g. sales-agent
  --dir      where to write the app (default: ./<app-id>); must be empty
  --name     display name (default: the id in title case)

The template is the one Rome's own app_management create uses: app.yaml,
an action, an agent, an API, a migrated table, a web UI, and the
pnpm-workspace.yaml and .gitignore a standalone app needs.
`;

/** The template ships in the published package under templates/app; in the
 *  monorepo it is read straight from packages/app-template. */
export function findTemplateDir(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  // In the monorepo the live template wins over a copy a local `prepack` left.
  const candidates = [
    join(packageRoot, "..", "app-template", "template"),
    join(packageRoot, "templates", "app"),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, "app.yaml")));
  if (!found)
    throw new CliError(`rome create: no app template found (looked in ${candidates.join(", ")})`);
  return found;
}

export async function runCreate(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  let appId: string | undefined;
  let dir: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dir" || arg === "--name") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) {
        throw new CliError(`rome create: ${arg} needs a value\n\n${HELP}`, 2);
      }
      if (arg === "--dir") dir = value;
      else name = value;
    } else if (!arg.startsWith("-") && appId === undefined) appId = arg;
    else throw new CliError(`rome create: unexpected argument "${arg}"\n\n${HELP}`, 2);
  }
  if (!appId || !isValidAppId(appId) || appId.startsWith("@")) {
    throw new CliError(
      `rome create: "${appId ?? ""}" is not a valid app id; use a lowercase slug such as sales-agent`,
      2,
    );
  }
  const destDir = resolve(dir ?? appId);
  if (await isDirectoryNonEmpty(destDir)) {
    throw new CliError(`rome create: ${destDir} is not empty`);
  }

  await materializeTemplate(findTemplateDir(), destDir, {
    appId,
    appName: name ?? appIdToDisplayName(appId),
  });
  process.stdout.write(`Created ${appId} in ${destDir}

Next:
  cd ${destDir}
  git init && pnpm install
  pnpm up --latest @rome-os/app-runtime @rome-os/app-web-sdk @rome-os/ui
  rome validate     # build, pack and check it the way an install does
  rome run          # serve the app's UI and API locally
`);
}
