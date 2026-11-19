// R11: lower layers stay ignorant. Reads the two checkouts named in env.json
// (`repos.rome`, `repos.romeCloud`) and runs nothing against the instances.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const git = async (dir, ...args) =>
  (await run("git", ["-C", dir, ...args], { maxBuffer: 64 << 20 })).stdout;

// What Rome Cloud may hold. R11's rule: Rome Cloud knows only which workspace
// goes to which instance. Allowed: the binding, the means of delivering to
// that instance, and sign-in attempt state. Message content and Slack member
// data are never allowed, in any table. An attempt table (one with an expiry
// and attempt state such as `state` or `code_challenge`) is judged by its
// lifetime, not its column names: every other column in it passes as an
// attempt field, as long as the product's code clears the sign-in outcome on
// redemption and deletes expired attempts. Outside attempt tables a Slack
// token fails, and a column that fits no kind is not judged.
const KINDS = [
  {
    kind: "message content",
    allowed: false,
    test: /^(text|body|content|message|message_?(text|body|content)|blocks|attachments|files?)$/i,
  },
  {
    kind: "Slack member data",
    allowed: false,
    test: /(^|_)(user_?name|real_?name|display_?name|email|avatar|profile|image|title|phone|tz|members?)($|_)|^(user_?id|slack_?user_?id|member_?id)$/i,
  },
  { kind: "Slack token", allowed: "token", test: /token/i },
  {
    kind: "binding",
    allowed: true,
    test: /^(id|team_?id|workspace_?id|enterprise_?id|(account_?)?instance_?id|app_?id|bot_?user_?id|status|(created|updated|bound|unbound|deleted)_?at)$/i,
  },
  {
    kind: "delivery",
    allowed: true,
    test: /^(mailbox_?id|mailbox|forward_?(secret|key)(_?(hash|enc(rypted)?))?|relay_?(secret|key)|delivery_?(secret|url))$/i,
  },
  {
    kind: "sign-in attempt",
    allowed: true,
    test: /^(state|oauth_?state|redirect_?uri|return_?(url|to)|code_?challenge(_?method)?|code_?verifier|nonce|handoff(_?(id|code|hash))?|code|(expires|redeemed|consumed|used)_?at)$/i,
  },
];

const kindOf = (name) => KINDS.find((k) => k.test.test(name)) ?? { kind: "unknown", allowed: null };

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
    const judged = stored.columns.map((c) => judge(c, stored));
    evidence.romeCloudStores = { files: stored.files, columns: judged };
    const bad = judged.filter((c) => c.allowed === false);
    // An attempt table whose lifetime fails is named once, not per column.
    const lifetimes = [
      ...new Set(
        bad.filter((c) => c.lifetime).map((c) => `sign-in attempts in ${c.table}: ${c.why}`),
      ),
    ];
    const columns = bad.filter((c) => !c.lifetime).map((c) => `${c.name} (${c.why})`);
    if (columns.length)
      problems.push(
        `Rome Cloud stores more than the workspace to instance binding: ${columns.join(", ")}`,
      );
    problems.push(...lifetimes);
    const unknown = judged.filter((c) => c.allowed === null);
    if (unknown.length)
      unchecked.push(
        `Rome Cloud adds column(s) the check cannot judge: ${unknown.map((c) => c.name).join(", ")}`,
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
    // Only imports the product adds count: ones already on its base are not
    // this product's. Every current one is listed either way.
    const appImports = importsOfApps(rome);
    const romeBase = ctx.env.repos.romeBase ?? "origin/main";
    const added = await addedAppImports(rome, romeBase, appImports);
    evidence.connectionsImportingApps = { base: romeBase, all: appImports, added };
    if (added === null) unchecked.push(`no base ${romeBase} in the rome checkout to diff against`);
    else if (added.length)
      problems.push(
        `${added.length} import(s) from rome_apps added in packages/core/src/connections`,
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
 * (schemas and migrations), against `base`, each with its table when the
 * check can tell. Also returns every added line under packages/pantheon, for
 * finding where a table's rows are removed.
 */
async function storedColumns(dir, base) {
  const changed = (await git(dir, "diff", "--name-only", base, "--", "packages/pantheon"))
    .split("\n")
    .filter(Boolean);
  const files = changed.filter(
    (f) => /(schema|migration|drizzle|\/db\/|\.sql$)/i.test(f) && !/\.(md|json|snap)$/.test(f),
  );
  const addedOf = async (file) =>
    (await git(dir, "diff", "-U0", base, "--", file))
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");
  const columns = [];
  const tables = [];
  const TYPE =
    "text|integer|varchar|timestamp|boolean|jsonb?|uuid|serial|bigint|real|blob|numeric|bytea";
  for (const file of files) {
    const added = await addedOf(file);
    const found = [];
    // Drizzle tables: `export const slackSignIns = pgTable("slack_sign_ins", {`.
    const starts = [
      ...added.matchAll(/(?:const\s+(\w+)\s*=\s*)?(?:\w+\.)?\w*[tT]able\(\s*["'](\w+)["']/g),
    ].map((m) => ({ at: m.index, table: m[2], variable: m[1] }));
    for (const t of starts) tables.push(t);
    const tableAt = (i) => starts.filter((t) => t.at < i).at(-1)?.table ?? null;
    // Drizzle: `teamId: text("team_id")`, or `pg.text(...)` from a namespace
    // import, anywhere on a line.
    for (const m of added.matchAll(
      new RegExp(`(\\w+)\\s*:\\s*(?:\\w+\\.)?(?:${TYPE})\\(\\s*(?:["'](\\w+)["'])?`, "g"),
    ))
      found.push({ name: m[2] ?? m[1], table: tableAt(m.index) });
    // SQL: every column of a CREATE TABLE, one line or many, ended by `;`
    // or by the end of the file.
    for (const { table, list } of createTableLists(added)) {
      tables.push({ table });
      for (const part of splitTop(list)) {
        const id = part.trim().match(/^[`"]?(\w+)[`"]?/)?.[1];
        if (id && !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK|KEY|INDEX)$/i.test(id))
          found.push({ name: id, table });
      }
    }
    // SQL: a column line added inside an existing CREATE TABLE.
    for (const m of added.matchAll(new RegExp(`^\\s*[\`"]?(\\w+)[\`"]?\\s+(?:${TYPE})\\b`, "gim")))
      found.push({ name: m[1], table: null });
    // SQL: ALTER TABLE t ADD [COLUMN] [IF NOT EXISTS] name.
    for (const m of added.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi,
    ))
      if (!/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|INDEX|CHECK)$/i.test(m[2]))
        found.push({ name: m[2], table: m[1] });
    // One entry per column: the one that names its table wins.
    const seen = new Map();
    for (const f of found) {
      const prior = seen.get(f.name);
      if (!prior || (!prior.table && f.table)) seen.set(f.name, f);
    }
    for (const f of seen.values()) columns.push({ file, ...f });
  }
  const allAdded = (await Promise.all(changed.map(addedOf))).join("\n");
  return { files, columns, tables, allAdded };
}

// A column that may hold the sign-in's outcome: the token, or Slack's answer
// that carries it.
const OUTCOME = /token|result|outcome|grant|install|credential/i;

const camel = (name) => name.replace(/_(\w)/g, (_m, c) => c.toUpperCase());

/**
 * How long an attempt table's rows live, from the product's added code: for
 * each outcome column, whether something clears it (set to null, or the row
 * deleted outside an expiry sweep), and whether something deletes expired
 * rows. Null when `table` is no attempt table.
 */
function lifetimeOf(table, { columns, tables, allAdded }) {
  if (!table) return null;
  const own = columns.filter((c) => c.table === table);
  const expiry = own.find((c) => /^(expires|expiry)/i.test(c.name));
  const attempt = own.some((c) => kindOf(c.name).kind === "sign-in attempt" && c !== expiry);
  if (!expiry || !attempt) return null;
  const variable = tables.find((x) => x.table === table && x.variable)?.variable;
  // Each delete of the table's rows, with the text that follows it, so a
  // sweep (its condition names the expiry) can be told from a redemption.
  const deletes = [
    ...allAdded.matchAll(new RegExp(`DELETE\\s+FROM\\s+[\`"]?${table}\\b`, "gi")),
    ...(variable ? [...allAdded.matchAll(new RegExp(`\\.delete\\(\\s*${variable}\\b`, "g"))] : []),
  ].map((m) => allAdded.slice(m.index, m.index + 300));
  const sweeps = deletes.some((d) => /expir/i.test(d));
  const redeemDeletes = deletes.some((d) => !/expir/i.test(d));
  const cleared = (name) =>
    redeemDeletes ||
    new RegExp(`\\b${name}\\b["'\`]?\\s*(=|:)\\s*null\\b`, "i").test(allAdded) ||
    new RegExp(`\\b${camel(name)}\\s*:\\s*null\\b`).test(allAdded);
  const outcomes = own
    .filter((c) => c !== expiry && OUTCOME.test(c.name))
    .map((c) => ({ name: c.name, clearedOnRedeem: cleared(c.name) }));
  return { table, expiry: expiry.name, sweepsExpired: sweeps, outcomes };
}

/**
 * Judges one stored column. Message content and member data fail anywhere.
 * In an attempt table every other column passes when the table's lifetime
 * holds: its outcome is cleared on redemption and expired rows are deleted.
 */
function judge(column, stored) {
  const k = kindOf(column.name);
  const out = { file: column.file, table: column.table, name: column.name, kind: k.kind };
  if (k.allowed === false) return { ...out, allowed: false, why: k.kind };
  const life = lifetimeOf(column.table, stored);
  if (life) {
    const kept = life.outcomes.filter((o) => !o.clearedOnRedeem).map((o) => o.name);
    const lifetime = { sweepsExpired: life.sweepsExpired, outcomes: life.outcomes };
    if (kept.length || !life.sweepsExpired)
      return {
        ...out,
        kind: "sign-in attempt",
        allowed: false,
        why: [
          kept.length &&
            `the sign-in outcome (${kept.join(", ")}) can remain after redemption: no code clears it`,
          !life.sweepsExpired && `no code deletes expired ${column.table} rows`,
        ]
          .filter(Boolean)
          .join("; "),
        lifetime,
      };
    return {
      ...out,
      kind: "sign-in attempt",
      allowed: true,
      why: "attempt field, held until redeemed or expired",
      lifetime,
    };
  }
  if (k.allowed === "token")
    return {
      ...out,
      allowed: false,
      why: column.table
        ? "a Slack token outside expiring sign-in attempt state"
        : "a Slack token in a table the check cannot name",
    };
  return { ...out, allowed: k.allowed };
}

/** The table and the text inside the outer parentheses of each `CREATE TABLE` in `sql`. */
function createTableLists(sql) {
  const lists = [];
  for (const m of sql.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"]?\w+[`"]?\.)?[`"]?(\w+)[`"]?[^(;]*\(/gi,
  )) {
    const from = m.index + m[0].length;
    let depth = 1;
    let i = from;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
    }
    lists.push({ table: m[1], list: sql.slice(from, depth === 0 ? i - 1 : i) });
  }
  return lists;
}

/** Splits a column list on the commas outside parentheses. */
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

/**
 * Of `current` (imports from apps now in packages/core/src/connections), the
 * ones the product adds against `base`: their import line is an added line
 * in that file's diff. Null when `base` is not in the checkout.
 */
async function addedAppImports(rome, base, current) {
  try {
    await git(rome, "rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  } catch {
    return null;
  }
  const added = [];
  for (const file of new Set(current.map((c) => c.file))) {
    const lines = (await git(rome, "diff", "-U0", base, "--", file))
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    for (const c of current.filter((x) => x.file === file))
      if (lines.some((l) => l.includes(c.import))) added.push(c);
  }
  return added;
}
