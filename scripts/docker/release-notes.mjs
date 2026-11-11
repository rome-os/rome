#!/usr/bin/env node
// Writes the GitHub release notes for a Rome runtime image release
// (docs/releases.md#github-release): the changes to the image since the
// previous published release, grouped by what they mean to someone running it.
//
//   node scripts/docker/release-notes.mjs <tag> <published-versions-file>
//
// The file lists the image's versions on Docker Hub, one per line. IMAGE_NAME
// and GITHUB_REPOSITORY name the image and the repository.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/**
 * The section a commit belongs to, and the line it shows there. A `!` after
 * the type or a `BREAKING CHANGE:` footer in the body makes it breaking.
 */
export function entryOf(subject, body = "") {
  const match = CONVENTIONAL.exec(subject);
  if (!match?.groups) return { section: "other", line: subject };
  const { type, scope, breaking, subject: text } = match.groups;
  const line = scope ? `**${scope}:** ${text}` : text;
  if (breaking || BREAKING_FOOTER.test(body)) return { section: "breaking", line };
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
 * @param {{ subject: string, body?: string, files: string[] }[]} release.commits Newest first.
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
    const { section, line } = entryOf(commit.subject, commit.body);
    grouped.set(section, [...(grouped.get(section) ?? []), line]);
  }

  out.push("", `## Changes since ${previousTag}`);
  if (grouped.size === 0) out.push("", "No changes to what the image runs.");
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, publishedFile] = process.argv.slice(2);
  const { IMAGE_NAME: image, GITHUB_REPOSITORY: repository } = process.env;
  if (!tag || !publishedFile || !image || !repository) {
    console.error(
      "usage: IMAGE_NAME=… GITHUB_REPOSITORY=… release-notes.mjs <tag> <published-versions-file>",
    );
    process.exit(2);
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const published = readFileSync(publishedFile, "utf8").split("\n").filter(Boolean);
  const previous = previousRelease(tag.replace(/^v/, ""), published);
  let previousTag = previous ? `v${previous}` : null;
  if (previousTag) {
    try {
      git("rev-parse", "--verify", "--quiet", `refs/tags/${previousTag}`);
    } catch {
      console.error(
        `Docker Hub has ${previous}, but no ${previousTag} tag exists; listing no changes.`,
      );
      previousTag = null;
    }
  }
  process.stdout.write(
    releaseNotes({
      tag,
      previousTag,
      sha: git("rev-parse", `${tag}^{commit}`),
      image,
      repository,
      commits: previousTag ? commitsBetween(previousTag, tag) : [],
    }),
  );
}
