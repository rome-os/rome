#!/usr/bin/env node
// Writes the GitHub release notes for a Rome runtime image release
// (docs/releases.md#github-release): the changes to the image since the
// previous published release, grouped by what they mean to someone running it.
//
//   node scripts/docker/release-notes.mjs <tag> <published-versions-file> [--json <path>]
//   node scripts/docker/release-notes.mjs backfill <out-dir> <tag>...
//
// The first form prints the Markdown notes and, with --json, also writes the
// same changes as release-notes.json, the asset instances read. The file lists
// the image's versions on Docker Hub, one per line. The backfill form writes
// release-notes.json for releases that already exist, and prints the
// `gh release upload` commands that attach them without running them.
// DEEPSEEK_API_KEY lets both forms write highlights. Without it, or when the
// model fails, the file has none and the release goes on.
// IMAGE_NAME and GITHUB_REPOSITORY name the image and the repository.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NO_HIGHLIGHTS, writeHighlights } from "./release-highlights.mjs";
import { isRuntimeInput } from "./runtime-inputs.mjs";

const STABLE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function compareStable(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * The release the notes count from: the highest stable version published
 * below `version`, or null for the first. Published versions, not git tags,
 * so the changes of a tag whose build never shipped roll into the next
 * release. A prerelease counts from the stable version before its own.
 */
export function previousRelease(version, published) {
  const base = version.replace(/-.*$/, "");
  const below = published
    .filter((candidate) => STABLE.test(candidate) && compareStable(candidate, base) < 0)
    .sort(compareStable);
  return below.at(-1) ?? null;
}

/**
 * Whether a commit that touches `files` changes the image: it touches a file
 * the image is built from. The docs ship too, for the agent to answer from,
 * but a commit whose only shipped files are docs is left out, since it
 * changes no behavior and would list app or tooling work that only updated
 * its docs.
 */
export function changesImage(files) {
  return files.some((file) => isRuntimeInput(file) && file !== "docs" && !file.startsWith("docs/"));
}

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

/** A Conventional Commits footer that marks a breaking change. */
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /m;

/** The `(#1234)` suffix squash-and-merge appends to a pull request's title. */
const PR_SUFFIX = / \(#(?<pr>[0-9]+)\)$/;

/**
 * The section a commit belongs to, and what it shows there: its scope, its
 * subject without the pull request suffix, and that pull request's number.
 * A `!` after the type or a `BREAKING CHANGE:` footer in the body makes it
 * breaking. A subject that is not a Conventional Commit has no scope.
 */
export function entryOf(subject, body = "") {
  const match = CONVENTIONAL.exec(subject);
  const { type, scope = null, breaking, subject: rest } = match?.groups ?? { subject };
  const pr = PR_SUFFIX.exec(rest);
  const entry = {
    scope,
    text: pr ? rest.slice(0, pr.index) : rest,
    pr: pr ? Number(pr.groups.pr) : null,
  };
  if (!match) return { section: "other", ...entry };
  if (breaking || BREAKING_FOOTER.test(body)) return { section: "breaking", ...entry };
  if (type === "feat") return { section: "new", ...entry };
  if (type === "fix" || type === "perf" || type === "revert") return { section: "fixes", ...entry };
  return { section: "internal", ...entry };
}

/** An entry's line in the Markdown notes. */
export function lineOf({ scope, text, pr }) {
  return `${scope ? `**${scope}:** ` : ""}${text}${pr === null ? "" : ` (#${pr})`}`;
}

/**
 * The commits that change the image, grouped by section. Release commits are
 * left out. Within a section, entries keep the commits' order.
 */
export function groupChanges(commits) {
  const grouped = new Map();
  for (const commit of commits) {
    if (/^chore(\([^)]*\))?: release\b/.test(commit.subject)) continue;
    if (!changesImage(commit.files)) continue;
    const { section, ...entry } = entryOf(commit.subject, commit.body);
    grouped.set(section, [...(grouped.get(section) ?? []), entry]);
  }
  return grouped;
}

const SECTIONS = [
  ["breaking", "Breaking changes"],
  ["new", "New"],
  ["fixes", "Fixes"],
  ["other", "Other changes"],
];

/**
 * The release notes, in Markdown.
 *
 * @param {object} release
 * @param {string} release.tag The release's git tag, `vX.Y.Z`.
 * @param {string | null} release.previousTag The previous published release's tag.
 * @param {string} release.sha The commit the image was built from.
 * @param {string} release.image The Docker Hub repository.
 * @param {string} release.repository The GitHub repository, `owner/name`.
 * @param {{ subject: string, body?: string, files: string[] }[]} release.commits Newest first.
 */
export function releaseNotes({ tag, previousTag, sha, image, repository, commits }) {
  const version = tag.replace(/^v/, "");
  const out = [
    `The Rome runtime image \`${image}:${version}\`, built from ${sha.slice(0, 7)}. Rome Cloud offers it to instances on its own. To run it yourself, pull \`${image}:${version}\`.`,
  ];
  if (!previousTag) return `${out.join("\n")}\n`;

  const grouped = groupChanges(commits);
  out.push("", `## Changes since ${previousTag}`);
  if (grouped.size === 0) out.push("", "No changes to what the image runs.");
  for (const [key, heading] of SECTIONS) {
    const entries = grouped.get(key);
    if (entries) out.push("", `### ${heading}`, "", ...entries.map((e) => `- ${lineOf(e)}`));
  }
  const internal = grouped.get("internal");
  if (internal) {
    out.push(
      "",
      "<details>",
      `<summary>Internal changes (${internal.length})</summary>`,
      "",
      ...internal.map((entry) => `- ${lineOf(entry)}`),
      "",
      "</details>",
    );
  }
  out.push(
    "",
    `**Full changelog:** https://github.com/${repository}/compare/${previousTag}...${tag}`,
  );
  return `${out.join("\n")}\n`;
}

/**
 * The version of the release-notes.json format. 2 adds `highlights` to the
 * fields of 1, so a reader of 1 can read 2 by ignoring them.
 */
export const NOTES_SCHEMA = 2;

/**
 * The release notes as release-notes.json, the asset instances read to show
 * what an upgrade changes. It lists the Breaking changes, New and Fixes of the
 * Markdown notes.
 * Each entry is `{ scope, text, pr }`, where scope and pr may be null.
 * `internal` counts the changes it does not list: internal ones and subjects
 * that are not Conventional Commits. A first release has no previousVersion
 * and lists nothing. `highlights` holds what the upgrade dialog shows, in
 * English and Chinese (release-highlights.mjs), and may be empty.
 *
 * @param {object} release
 * @param {string} release.tag The release's git tag, `vX.Y.Z`.
 * @param {string | null} release.previousTag The previous published release's tag.
 * @param {string} release.date When the release was published, as an ISO 8601 timestamp.
 * @param {string} release.repository The GitHub repository, `owner/name`.
 * @param {{ subject: string, body?: string, files: string[] }[]} release.commits Newest first.
 * @param {{ en: { text: string, pr: number }[], zh: { text: string, pr: number }[] }} [release.highlights]
 */
export function releaseNotesJson({
  tag,
  previousTag,
  date,
  repository,
  commits,
  highlights = NO_HIGHLIGHTS,
}) {
  const grouped = previousTag ? groupChanges(commits) : new Map();
  return {
    schema: NOTES_SCHEMA,
    version: tag.replace(/^v/, ""),
    previousVersion: previousTag ? previousTag.replace(/^v/, "") : null,
    date,
    url: `https://github.com/${repository}/releases/tag/${tag}`,
    breaking: grouped.get("breaking") ?? [],
    new: grouped.get("new") ?? [],
    fixes: grouped.get("fixes") ?? [],
    internal: (grouped.get("internal")?.length ?? 0) + (grouped.get("other")?.length ?? 0),
    highlights,
  };
}

/** The commits in `previousTag..tag`, newest first, with their bodies and files. */
function commitsBetween(previousTag, tag) {
  const log = execFileSync(
    "git",
    ["log", "--no-merges", "--format=%x1e%s%x1f%b%x1f", "--name-only", `${previousTag}..${tag}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return log
    .split("\x1e")
    .slice(1)
    .map((block) => {
      const [subject = "", body = "", names = ""] = block.split("\x1f");
      return { subject, body, files: names.split("\n").filter(Boolean) };
    });
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/**
 * The previous release's tag, or null when there is none or its git tag is
 * missing, in which case the notes list no changes.
 */
function previousTagOf(tag, published) {
  const previous = previousRelease(tag.replace(/^v/, ""), published);
  if (!previous) return null;
  try {
    git("rev-parse", "--verify", "--quiet", `refs/tags/v${previous}`);
  } catch {
    console.error(
      `Docker Hub has ${previous}, but no v${previous} tag exists; listing no changes.`,
    );
    return null;
  }
  return `v${previous}`;
}

/** The title and description of each pull request the notes cite. One that cannot be read is left out. */
function pullsOf(notes, repository) {
  const pulls = new Map();
  for (const { pr } of [...notes.breaking, ...notes.new, ...notes.fixes]) {
    if (pr === null || pulls.has(pr)) continue;
    try {
      const out = execFileSync(
        "gh",
        ["pr", "view", String(pr), "--repo", repository, "--json", "title,body"],
        { encoding: "utf8" },
      );
      const { title, body } = JSON.parse(out);
      pulls.set(pr, { title, body: body ?? "" });
    } catch {
      console.error(`Could not read pull request #${pr}; its subject stands alone.`);
    }
  }
  return pulls;
}

/** release-notes.json for a release, with the model's highlights. */
async function notesWithHighlights(release) {
  const plain = releaseNotesJson(release);
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const highlights = await writeHighlights({
    notes: plain,
    pulls: apiKey ? pullsOf(plain, release.repository) : new Map(),
    apiKey,
  });
  return { ...plain, highlights };
}

/** Every tag of the image on Docker Hub. */
async function publishedOnDockerHub(image) {
  const names = [];
  let url = `https://hub.docker.com/v2/repositories/${image}/tags?page_size=100`;
  while (url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Docker Hub answered ${response.status} for ${url}`);
    const page = await response.json();
    names.push(...page.results.map((result) => result.name));
    url = page.next;
  }
  return names;
}

function usage() {
  console.error(
    [
      "usage: IMAGE_NAME=… GITHUB_REPOSITORY=… release-notes.mjs <tag> <published-versions-file> [--json <path>]",
      "       IMAGE_NAME=… GITHUB_REPOSITORY=… release-notes.mjs backfill <out-dir> <tag>...",
    ].join("\n"),
  );
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const { IMAGE_NAME: image, GITHUB_REPOSITORY: repository } = process.env;
  if (!image || !repository) usage();

  if (args[0] === "backfill") {
    // Reads the published releases and writes files only. The upload stays
    // with whoever runs the printed commands.
    const [, outDir, ...tags] = args;
    if (!outDir || tags.length === 0) usage();
    const published = await publishedOnDockerHub(image);
    for (const tag of tags) {
      const date = execFileSync(
        "gh",
        [
          "release",
          "view",
          tag,
          "--repo",
          repository,
          "--json",
          "publishedAt",
          "--jq",
          ".publishedAt",
        ],
        { encoding: "utf8" },
      ).trim();
      const previousTag = previousTagOf(tag, published);
      const notes = await notesWithHighlights({
        tag,
        previousTag,
        date,
        repository,
        commits: previousTag ? commitsBetween(previousTag, tag) : [],
      });
      const file = join(outDir, tag, "release-notes.json");
      mkdirSync(join(outDir, tag), { recursive: true });
      writeFileSync(file, `${JSON.stringify(notes, null, 2)}\n`);
      // --clobber replaces a file an earlier backfill attached.
      console.log(`gh release upload ${tag} ${file} --repo ${repository} --clobber`);
    }
  } else {
    const jsonAt = args.indexOf("--json");
    const jsonFile = jsonAt === -1 ? null : args[jsonAt + 1];
    if (jsonAt !== -1) args.splice(jsonAt, 2);
    const [tag, publishedFile] = args;
    if (!tag || !publishedFile || (jsonAt !== -1 && !jsonFile)) usage();
    const published = readFileSync(publishedFile, "utf8").split("\n").filter(Boolean);
    const previousTag = previousTagOf(tag, published);
    const commits = previousTag ? commitsBetween(previousTag, tag) : [];
    process.stdout.write(
      releaseNotes({
        tag,
        previousTag,
        sha: git("rev-parse", `${tag}^{commit}`),
        image,
        repository,
        commits,
      }),
    );
    if (jsonFile) {
      const notes = await notesWithHighlights({
        tag,
        previousTag,
        date: new Date().toISOString(),
        repository,
        commits,
      });
      writeFileSync(jsonFile, `${JSON.stringify(notes, null, 2)}\n`);
    }
  }
}
