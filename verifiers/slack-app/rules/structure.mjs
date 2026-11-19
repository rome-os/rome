// R11: lower layers stay ignorant. Reads the two checkouts named in env.json
// (`repos.rome`, `repos.romeCloud`) and runs nothing against the instances.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const git = async (dir, ...args) =>
  (await run("git", ["-C", dir, ...args], { maxBuffer: 64 << 20 })).stdout;

/** Columns a workspace to instance binding may hold. Anything else is a finding. */
const BINDING_COLUMN =
  /^(id|team_?id|workspace_?id|enterprise_?id|instance_?id|app_?id|created_?at|updated_?at|bound_?at)$/i;

export async function r11(ctx) {
  const { rome, romeCloud, romeCloudBase } = ctx.env.repos;
  const evidence = {};
  const problems = [];
  const unchecked = [];

  if (romeCloud && existsSync(romeCloud)) {
    const relay = (
      await git(romeCloud, "diff", "--name-only", romeCloudBase, "--", "webhook-relay")
    ).trim();
    evidence.relayDiff = { base: romeCloudBase, files: relay ? relay.split("\n") : [] };
    if (relay)
      problems.push(
        `the webhook relay differs from ${romeCloudBase} in ${relay.split("\n").length} file(s)`,
      );

    const stored = await storedColumns(romeCloud, romeCloudBase);
    evidence.romeCloudStores = stored;
    const extra = stored.columns.filter((c) => !BINDING_COLUMN.test(c.name));
    if (extra.length)
      problems.push(
        `Rome Cloud stores more than the workspace to instance binding: ${extra.map((c) => c.name).join(", ")}`,
      );
  } else {
    unchecked.push("no rome-cloud checkout (repos.romeCloud)");
  }

  if (rome && existsSync(rome)) {
    if (ctx.env.repos.romeDependencies === "failed") {
      evidence.importRules = "not run: the environment could not install rome's dependencies";
      unchecked.push("rome's import rules not run: its dependencies failed to install");
    } else {
      try {
        await run("pnpm", ["run", "--silent", "lint:imports"], { cwd: rome, maxBuffer: 64 << 20 });
        evidence.importRules = "pass";
      } catch (err) {
        const out = `${err.stdout ?? ""}${err.stderr ?? ""}`
          .trim()
          .split("\n")
          .slice(-15)
          .join("\n");
        evidence.importRules = { exitCode: err.code, tail: out };
        problems.push("rome's import rules fail");
      }
    }
    const appImports = importsOfApps(rome);
    evidence.connectionsImportingApps = appImports;
    if (appImports.length)
      problems.push(
        `${appImports.length} import(s) from rome_apps in packages/core/src/connections`,
      );
  } else {
    unchecked.push("no rome checkout (repos.rome)");
  }

  if (problems.length) return { result: "fail", reason: problems.join("; "), evidence };
  if (unchecked.length) return { result: "not checked", reason: unchecked.join("; "), evidence };
  return {
    result: "pass",
    reason:
      "The relay is unchanged, the import rules pass, connections import nothing from apps, and Rome Cloud stores only the binding.",
    evidence,
  };
}

/**
 * Columns added under packages/pantheon in files that define stored data
 * (schemas and migrations), against `base`. Reads Drizzle column calls, SQL
 * column lines and `ALTER TABLE ... ADD COLUMN` from the added lines of the diff.
 */
async function storedColumns(dir, base) {
  const files = (await git(dir, "diff", "--name-only", base, "--", "packages/pantheon"))
    .split("\n")
    .filter(
      (f) => /(schema|migration|drizzle|\/db\/|\.sql$)/i.test(f) && !/\.(md|json|snap)$/.test(f),
    );
  const columns = [];
  for (const file of files) {
    const diff = await git(dir, "diff", "-U0", base, "--", file);
    for (const line of diff.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const drizzle = line.match(
        /^\+\s*(\w+)\s*:\s*(text|integer|varchar|timestamp|boolean|jsonb?|uuid|serial|bigint|real|blob)\(\s*(?:["'](\w+)["'])?/,
      );
      const sql = line.match(
        /^\+\s*[`"]?(\w+)[`"]?\s+(TEXT|INTEGER|VARCHAR|TIMESTAMP|BOOLEAN|JSONB?|UUID|BIGINT|BLOB)\b/i,
      );
      const altered = line.match(/\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i);
      const name = drizzle ? (drizzle[3] ?? drizzle[1]) : (sql?.[1] ?? altered?.[1]);
      if (name) columns.push({ file, name });
    }
  }
  return { files, columns };
}

/** Imports in packages/core/src/connections whose source is an app. */
function importsOfApps(rome) {
  const appsDir = join(rome, "rome_apps");
  const names = existsSync(appsDir)
    ? readdirSync(appsDir)
        .map((d) => join(appsDir, d, "package.json"))
        .filter(existsSync)
        .map((p) => JSON.parse(readFileSync(p, "utf8")).name)
        .filter(Boolean)
    : [];
  const hits = [];
  const root = join(rome, "packages/core/src/connections");
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(m?[jt]sx?)$/.test(entry)) {
        const src = readFileSync(path, "utf8");
        for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
          const spec = m[1];
          if (
            spec.includes("rome_apps") ||
            names.some((n) => spec === n || spec.startsWith(`${n}/`))
          )
            hits.push({ file: path.slice(rome.length + 1), import: spec });
        }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return hits;
}
