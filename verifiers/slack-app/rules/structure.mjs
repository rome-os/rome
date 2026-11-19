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
  /^(id|team_?id|workspace_?id|enterprise_?id|(account_?)?instance_?id|app_?id|created_?at|updated_?at|bound_?at)$/i;

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
  const TYPE = "text|integer|varchar|timestamp|boolean|jsonb?|uuid|serial|bigint|real|blob|numeric";
  for (const file of files) {
    const diff = await git(dir, "diff", "-U0", base, "--", file);
    const added = diff
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");
    const names = new Set();
    // Drizzle: `teamId: text("team_id")`, anywhere on a line.
    for (const m of added.matchAll(
      new RegExp(`(\\w+)\\s*:\\s*(?:${TYPE})\\(\\s*(?:["'](\\w+)["'])?`, "g"),
    ))
      names.add(m[2] ?? m[1]);
    // SQL: every column of a CREATE TABLE, one line or many, ended by `;`
    // or by the end of the file.
    for (const list of createTableLists(added))
      for (const part of splitTop(list)) {
        const id = part.trim().match(/^[`"]?(\w+)[`"]?/)?.[1];
        if (id && !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK|KEY|INDEX)$/i.test(id)) names.add(id);
      }
    // SQL: a column line added inside an existing CREATE TABLE.
    for (const m of added.matchAll(new RegExp(`^\\s*[\`"]?(\\w+)[\`"]?\\s+(?:${TYPE})\\b`, "gim")))
      names.add(m[1]);
    // SQL: ALTER TABLE ... ADD [COLUMN] [IF NOT EXISTS] name.
    for (const m of added.matchAll(
      /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi,
    ))
      if (!/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|INDEX|CHECK)$/i.test(m[1])) names.add(m[1]);
    for (const name of names) columns.push({ file, name });
  }
  return { files, columns };
}

/** Splits a column list on the commas outside parentheses. */
/** The text inside the outer parentheses of each `CREATE TABLE` in `sql`. */
function createTableLists(sql) {
  const lists = [];
  for (const m of sql.matchAll(/CREATE\s+TABLE[^(;]*\(/gi)) {
    const from = m.index + m[0].length;
    let depth = 1;
    let i = from;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
    }
    lists.push(sql.slice(from, depth === 0 ? i - 1 : i));
  }
  return lists;
}

function splitTop(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts;
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
