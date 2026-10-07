import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isMap, isScalar, isSeq, parseDocument, YAMLSeq } from "yaml";

/**
 * The `user-skills` carrier app is where reviewed skills live. It is the same
 * carrier the Skills app's import-skill flow installs into: a skill only
 * reaches the catalog once the app that lists it is installed, so writing a
 * SKILL.md anywhere else (e.g. a repo-relative `rome_apps/`) saves nothing an
 * agent can find.
 */
export const USER_SKILLS_APP_ID = "user-skills";

export function userSkillsCarrierDir(env: NodeJS.ProcessEnv = process.env): string {
  const authoringRoot =
    env.ROME_APP_AUTHORING_ROOT ??
    join(homedir(), ".rome", env.ROME_PROFILE || "default", "projects", "apps");
  return resolve(authoringRoot, USER_SKILLS_APP_ID);
}

// Keep this scaffold in sync with the copy in
// rome_apps/skills/src/skills/import-skill/SKILL.md ("Skills install into one
// carrier app"): both create the same carrier.
const APP_YAML = `formatVersion: 2
id: user-skills
name: User Skills
version: 0.1.0
description: Skills imported or generated via the Skills app.
icon: assets/icon.svg
web:
  manifest: web/manifest.json
skills: []
`;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="14" fill="#6366F1"/>
  <path d="M33 14 21 32h7l-3 13 12-18h-7l3-13Z" fill="#fff" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="44" cy="44" r="11" fill="#fff"/>
  <path d="M44 39v10M39 44h10" stroke="#6366F1" stroke-width="2.5" stroke-linecap="round"/>
</svg>
`;

const MANIFEST = `${JSON.stringify(
  {
    entry: "index.js",
    styles: [],
    assetVersion: "000000000001",
    displayName: "User Skills",
    navLabel: "User Skills",
    routing: "client",
  },
  null,
  2,
)}
`;

const WEB_ENTRY = `export function mount(root) {
  root.innerHTML = \`
    <div style="display:flex;min-height:100%;align-items:center;justify-content:center;font-family:var(--font-sans,sans-serif);color:var(--foreground,#111)">
      <div style="max-width:28rem;text-align:center;padding:3rem 2rem">
        <h1 style="font-size:1.25rem;font-weight:600;margin:0 0 .5rem">User Skills</h1>
        <p style="margin:0 0 1.25rem;font-size:.875rem;color:var(--muted-foreground,#666)">
          This app only carries the skills you import or generate.
          Browse, search, and manage them in the Skills app.
        </p>
        <a href="/apps/skills" id="open-skills" style="color:var(--primary,#6366f1);font-weight:500;text-decoration:none">Open Skills &rarr;</a>
      </div>
    </div>\`;
  root.querySelector("#open-skills").addEventListener("click", (e) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("rome:host-navigate", { detail: { path: "/apps/skills" } }));
  });
}
`;

/** Creates the carrier with the same minimal layout import-skill writes, if missing. */
export async function ensureUserSkillsCarrier(dir: string): Promise<void> {
  await mkdir(join(dir, "skills"), { recursive: true });
  await mkdir(join(dir, "assets"), { recursive: true });
  await mkdir(join(dir, "web"), { recursive: true });
  const files: Array<[string, string]> = [
    ["app.yaml", APP_YAML],
    ["assets/icon.svg", ICON_SVG],
    ["web/manifest.json", MANIFEST],
    ["web/index.js", WEB_ENTRY],
    ["package.json", `${JSON.stringify({ name: "user-skills", private: true, type: "module" })}\n`],
  ];
  for (const [path, content] of files) {
    const target = join(dir, path);
    if (!existsSync(target)) await writeFile(target, content);
  }
}

/** Content hash of every `skills/<name>/SKILL.md`, keyed by folder. */
export async function snapshotCarrierSkills(dir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const entries = await readdir(join(dir, "skills"), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const content = await readFile(join(dir, "skills", entry.name, "SKILL.md")).catch(() => null);
    if (content) snapshot.set(entry.name, createHash("sha256").update(content).digest("hex"));
  }
  return snapshot;
}

/** Skill folders added or edited between two snapshots, sorted. */
export function changedSkills(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after]
    .filter(([name, hash]) => before.get(name) !== hash)
    .map(([name]) => name)
    .sort();
}

function entryPath(item: unknown): string | undefined {
  if (isScalar(item)) return String(item.value);
  if (isMap(item)) {
    const path = item.get("path");
    return typeof path === "string" ? path : undefined;
  }
  return undefined;
}

const normalize = (path: string) => path.replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * Adds every `skills/<name>` folder that has a SKILL.md to `skills:` in
 * app.yaml. Existing entries keep their form (scalar, `{ path, publicName }`,
 * flow list) and the rest of the file is untouched; folders are matched by
 * path, so nothing is listed twice. Returns the resulting list of paths.
 */
export async function registerCarrierSkills(dir: string): Promise<string[]> {
  const onDisk = [...(await snapshotCarrierSkills(dir)).keys()].sort().map((n) => `skills/${n}`);
  const yamlPath = join(dir, "app.yaml");
  const doc = parseDocument(await readFile(yamlPath, "utf8"));
  if (doc.errors.length > 0) throw new Error(`invalid ${yamlPath}: ${doc.errors[0]?.message}`);

  const existing = doc.get("skills", true);
  const seq = isSeq(existing) ? existing : new YAMLSeq();
  if (seq !== existing) doc.set("skills", seq);
  const listed = seq.items.map(entryPath).filter((p): p is string => p !== undefined);
  const known = new Set(listed.map(normalize));
  const added = onDisk.filter((p) => !known.has(p));
  if (added.length > 0) {
    // A flow list (`skills: []` or `[a, b]`) is rewritten in block style.
    seq.flow = false;
    for (const path of added) seq.add(doc.createNode(path));
    await writeFile(yamlPath, doc.toString());
  }
  return [...listed, ...added];
}

const LOCK_STALE_MS = 2 * 60_000;
const LOCK_REFRESH_MS = 15_000;

/**
 * Runs `fn` while holding a lock on the carrier shared by every worker on this
 * host, so overlapping reviews register and install one at a time. Without it,
 * one review's app.yaml write can drop another's skill before either installs.
 * The holder keeps the lock fresh, so only a crashed holder's lock goes stale.
 */
export async function withCarrierLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const id = createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);
  const lock = join(tmpdir(), `rome-user-skills-${id}.lock`);
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
      else await new Promise((r) => setTimeout(r, 100));
    }
  }
  const refresh = setInterval(() => {
    const now = new Date();
    utimes(lock, now, now).catch(() => {});
  }, LOCK_REFRESH_MS);
  refresh.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(refresh);
    await rm(lock, { recursive: true, force: true });
  }
}

const run = promisify(execFile);

/**
 * Commits app.yaml and the given skill folders when the carrier is a git repo,
 * as import-skill does per skill, so Dream's edits don't get folded into an
 * unrelated later commit. Other uncommitted changes are left alone.
 */
export async function commitCarrier(dir: string, skills: string[]): Promise<void> {
  if (!existsSync(join(dir, ".git"))) return;
  const paths = ["app.yaml", ...skills.map((name) => `skills/${name}`)];
  await run("git", ["add", "--", ...paths], { cwd: dir });
  const staged = await run("git", ["diff", "--cached", "--quiet", "--", ...paths], {
    cwd: dir,
  }).then(
    () => false,
    () => true,
  );
  if (!staged) return;
  await run("git", ["commit", "-m", `Dream: update skill ${skills.join(", ")}`, "--", ...paths], {
    cwd: dir,
  });
}
