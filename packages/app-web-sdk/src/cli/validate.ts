import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { packArtifact, resolveApiEntryPath } from "@rome-os/app-runtime/packaging";
import { init as initLexer, parse as parseModule } from "es-module-lexer";
import {
  type AppOnDisk,
  artifactPaths,
  loadActionModules,
  loadApiFactory,
  loadHookFactory,
  readAppOnDisk,
} from "./appModules.js";
import { runBuild } from "./build.js";
import { CliError } from "./store/config.js";

const HELP = `rome validate — check an app the way an install does, without a Rome

Usage: rome validate [--no-build]

  1. Builds the app (rome build), unless --no-build.
  2. Packs it into a temporary directory with the same strict app.yaml schema
     and per-artifact checks the daemon runs on install. .rome/artifact, where
     an installed app's artifact lives, is left alone.
  3. Checks that every package the actions, hooks and API import is in
     dependencies, peerDependencies or optionalDependencies. An install runs
     pnpm install --prod, so a dev dependency is missing at runtime.
  4. Imports every action, hook and the API entry from the build, and checks
     each exports the factory the host calls.

Exits 1 with the first problem found.
`;

export async function runValidate(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const unknown = argv.filter((arg) => arg !== "--no-build");
  if (unknown.length > 0)
    throw new CliError(`rome validate: unknown argument(s): ${unknown.join(" ")}`, 2);

  const app = await readAppOnDisk(process.cwd());
  if (!argv.includes("--no-build")) {
    process.chdir(app.appDir);
    await runBuild();
  }

  // Not .rome/artifact: an in-Rome publish compares that one against the
  // installed hash, and only an install may replace it.
  const outDir = join(mkdtempSync(join(tmpdir(), "rome-validate-")), "artifact");
  try {
    await packArtifact(app.appDir, outDir, { clean: true });
  } catch (err) {
    throw new CliError(`✗ pack: ${err instanceof Error ? err.message : String(err)}`, 1);
  } finally {
    rmSync(dirname(outDir), { recursive: true, force: true });
  }
  process.stdout.write(`✓ pack: ${app.manifest.id}@${app.manifest.version}\n`);

  const { missing, scanned } = await devOnlyImports(app);
  if (missing.length > 0) {
    throw new CliError(
      `✗ imports: ${missing.join("; ")}. An install skips devDependencies; move them to dependencies.`,
      1,
    );
  }
  process.stdout.write(
    scanned > 0
      ? "✓ imports: every runtime package is a dependency\n"
      : "- imports: no compiled .js modules found, so the dependency check was skipped\n",
  );

  try {
    const actions = await loadActionModules(app);
    for (const path of artifactPaths(app.manifest, "hooks")) await loadHookFactory(app, path);
    const api = await loadApiFactory(app);
    process.stdout.write(
      `✓ modules: ${actions.length} action(s), ${artifactPaths(app.manifest, "hooks").length} hook(s)${api ? ", API entry" : ""}\n`,
    );
  } catch (err) {
    throw new CliError(`✗ modules: ${err instanceof Error ? err.message : String(err)}`, 1);
  }
}

/** Each bare import in the code the host loads (action and hook directories,
 *  the API entry, and the files they import) whose package an install's
 *  `pnpm install --prod` leaves out, as "file imports pkg". */
export async function devOnlyImports(
  app: AppOnDisk,
): Promise<{ missing: string[]; scanned: number }> {
  await initLexer;
  const pkgPath = join(app.appDir, "package.json");
  if (!existsSync(pkgPath)) return { missing: [], scanned: 0 };
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string>>;
  const installed = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);

  const queue: string[] = [];
  const addDir = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && SCRIPT.test(entry.name)) queue.push(join(entry.parentPath, entry.name));
    }
  };
  for (const path of artifactPaths(app.manifest, "actions")) addDir(join(app.builtRoot, path));
  for (const path of artifactPaths(app.manifest, "hooks")) addDir(join(app.builtRoot, path));
  if (app.manifest.api) {
    // The host's default entry, as in loadApiFactory.
    const entry = app.manifest.api.entry ?? "api/index";
    queue.push(resolveApiEntryPath(app.builtRoot, entry, app.manifest.id));
  }

  const seen = new Set<string>();
  const found = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    // Only compiled modules are read; an app run from TypeScript source is
    // reported as unchecked rather than passed.
    if (seen.has(file) || !SCRIPT.test(file) || !existsSync(file)) continue;
    seen.add(file);
    // A lexer, not a regex, so a specifier in a comment or string is not read
    // as an import. Dynamic imports with a computed specifier have no name.
    const [imports] = parseModule(readFileSync(file, "utf8"));
    for (const { n: specifier } of imports) {
      if (!specifier || specifier.startsWith("#")) continue;
      if (specifier.startsWith(".")) {
        const target = resolveRelative(dirname(file), specifier);
        if (target) queue.push(target);
      } else if (!isBuiltin(specifier) && !installed.has(packageName(specifier))) {
        found.add(`${relative(app.appDir, file)} imports ${packageName(specifier)}`);
      }
    }
  }
  return { missing: [...found], scanned: seen.size };
}

const SCRIPT = /\.(?:js|mjs|cjs)$/;

function resolveRelative(dir: string, specifier: string): string | undefined {
  const base = resolve(dir, specifier);
  return [base, `${base}.js`, join(base, "index.js")].find(
    (candidate) => SCRIPT.test(candidate) && existsSync(candidate) && statSync(candidate).isFile(),
  );
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]!);
}
