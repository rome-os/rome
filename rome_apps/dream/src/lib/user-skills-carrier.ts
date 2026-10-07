import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

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

export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, resolve(dir, path));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

/**
 * Lists every `skills/<name>/SKILL.md` folder under `skills:` in app.yaml,
 * keeping entries already there. The agent only writes SKILL.md files, so
 * registration stays deterministic.
 */
export async function registerCarrierSkills(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, "skills"), { withFileTypes: true });
  const onDisk = entries
    .filter((e) => e.isDirectory() && existsSync(join(dir, "skills", e.name, "SKILL.md")))
    .map((e) => `skills/${e.name}`)
    .sort();

  const yamlPath = join(dir, "app.yaml");
  const lines = (await readFile(yamlPath, "utf8")).split("\n");
  const start = lines.findIndex((line) => /^skills:/.test(line));
  const listed: string[] = [];
  let end = start + 1;
  if (start !== -1) {
    for (; end < lines.length; end++) {
      const item = /^\s+-\s+(.+?)\s*$/.exec(lines[end] ?? "");
      if (!item) break;
      listed.push(item[1].replace(/^["']|["']$/g, ""));
    }
  }
  const skills = [...listed, ...onDisk.filter((s) => !listed.includes(s))];
  const block =
    skills.length === 0 ? ["skills: []"] : ["skills:", ...skills.map((s) => `  - ${s}`)];
  if (start === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(...block, "");
  } else {
    lines.splice(start, end - start, ...block);
  }
  await writeFile(yamlPath, lines.join("\n"));
  return skills;
}
