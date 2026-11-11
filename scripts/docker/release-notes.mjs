#!/usr/bin/env node
// Writes the GitHub release notes for a Rome runtime image release
// (docs/releases.md#github-release): the changes to the image since the
// previous published release, grouped by what they mean to someone running it.
//
//   node scripts/docker/release-notes.mjs <tag> [<previous-tag>]
//
// IMAGE_NAME and GITHUB_REPOSITORY name the image and the repository. Without
// a previous tag, the notes list no changes.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Paths whose changes never reach the image: the apps and docs that ship on
 * their own, and the repository's own tooling. A commit that touches only
 * these is left out of the notes.
 */
const OUTSIDE_IMAGE = [
  "ios/",
  "packages/desktop/",
  "packages/desktop-base-web/",
  "packages/mobile/",
  "packages/cdp-client/",
  "packages/channel-test-ui/",
  "packages/pantheon/",
  "docs/",
  ".github/",
  ".claude/",
];

/** Whether a commit that touches `files` changes the image. */
export function changesImage(files) {
  return files.some(
    (file) =>
      !OUTSIDE_IMAGE.some((prefix) => file.startsWith(prefix)) &&
      !(!file.includes("/") && file.endsWith(".md")),
  );
}

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

/** The section a commit subject belongs to, and the line it shows there. */
export function entryOf(subject) {
  const match = CONVENTIONAL.exec(subject);
  if (!match?.groups) return { section: "other", line: subject };
  const { type, scope, breaking, subject: text } = match.groups;
  const line = scope ? `**${scope}:** ${text}` : text;
  if (breaking) return { section: "breaking", line };
  if (type === "feat") return { section: "new", line };
  if (type === "fix" || type === "perf" || type === "revert") return { section: "fixes", line };
  return { section: "internal", line };
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
 * @param {{ subject: string, files: string[] }[]} release.commits Newest first.
 */
export function releaseNotes({ tag, previousTag, sha, image, repository, commits }) {
  const version = tag.replace(/^v/, "");
  const out = [
    `The Rome runtime image \`${image}:${version}\`, built from ${sha.slice(0, 7)}. Rome Cloud offers it to instances on its own. To run it yourself, pull \`${image}:${version}\`.`,
  ];
  if (!previousTag) return `${out.join("\n")}\n`;

  const grouped = new Map();
  for (const commit of commits) {
    if (/^chore(\([^)]*\))?: release\b/.test(commit.subject)) continue;
    if (!changesImage(commit.files)) continue;
    const { section, line } = entryOf(commit.subject);
    grouped.set(section, [...(grouped.get(section) ?? []), line]);
  }

  out.push("", `## Changes since ${previousTag}`);
  if (grouped.size === 0) out.push("", "No changes to the image.");
  for (const [key, heading] of SECTIONS) {
    const lines = grouped.get(key);
    if (lines) out.push("", `### ${heading}`, "", ...lines.map((line) => `- ${line}`));
  }
  const internal = grouped.get("internal");
  if (internal) {
    out.push(
      "",
      "<details>",
      `<summary>Internal changes (${internal.length})</summary>`,
      "",
      ...internal.map((line) => `- ${line}`),
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

/** The commits in `previousTag..tag`, newest first, with the files each touches. */
function commitsBetween(previousTag, tag) {
  const log = execFileSync(
    "git",
    ["log", "--no-merges", "--format=%x1e%s", "--name-only", `${previousTag}..${tag}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return log
    .split("\x1e")
    .slice(1)
    .map((block) => {
      const [subject = "", ...files] = block.split("\n");
      return { subject, files: files.filter(Boolean) };
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, previousTag] = process.argv.slice(2);
  const { IMAGE_NAME: image, GITHUB_REPOSITORY: repository } = process.env;
  if (!tag || !image || !repository) {
    console.error(
      "usage: IMAGE_NAME=… GITHUB_REPOSITORY=… release-notes.mjs <tag> [<previous-tag>]",
    );
    process.exit(2);
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const sha = git("rev-parse", `${tag}^{commit}`);
  process.stdout.write(
    releaseNotes({
      tag,
      previousTag: previousTag || null,
      sha,
      image,
      repository,
      commits: previousTag ? commitsBetween(previousTag, tag) : [],
    }),
  );
}
