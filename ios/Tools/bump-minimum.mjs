#!/usr/bin/env node
// Raises the app's minimum instance versions before a TestFlight build, from
// the entries iOS PRs left in ios/Config/pending-minimum.json. Each entry
// names the server change that brings an API the app now calls; the minimum
// becomes the newest published server release, once it contains every change.
// The script only edits files: committing and pushing stay with whoever runs it.
//
// Usage: node ios/Tools/bump-minimum.mjs [--repo <dir>] [--no-fetch]
//        node ios/Tools/bump-minimum.mjs --check [--pending <file>]
//
// --check only reads the pending file and fails while it has entries, so a
// Release archive never ships with a minimum it was meant to raise. The
// archive's build phase runs it (ios/README.md, "Release to TestFlight").

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PENDING_PATH = "ios/Config/pending-minimum.json";
export const GATE_PATH = "ios/Rome/Features/Update/InstanceUpdater.swift";
export const TIERS = ["background", "blocking"];

/** "v1.1.204" or "1.1.204" as [1, 1, 204]; null when it is not a release number. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Stable server release tags (`v1.*`), newest first. */
export function releaseTags(tags) {
  return tags
    .filter((tag) => tag.startsWith("v1.") && parseVersion(tag))
    .sort((a, b) => compareVersions(b, a));
}

/** How many of the newest tags are asked about before giving up. */
export const PUBLISHED_LOOKBACK = 5;

/**
 * The newest release tag that is published, or the reason to stop. A tag is
 * pushed before its image builds; the release flow creates the GitHub release
 * only once the image is out (docs/releases.md). `published(tag)` answers
 * true, a reason the tag is not published, or `{ error }` when it cannot say.
 */
export function publishedRelease(tags, published) {
  const skipped = [];
  for (const tag of releaseTags(tags).slice(0, PUBLISHED_LOOKBACK)) {
    const status = published(tag);
    if (status === true) return { tag, skipped };
    if (typeof status === "object") {
      return {
        stop: `Cannot confirm that ${tag} is published (${status.error}). Minimums not raised.`,
      };
    }
    skipped.push(`${tag}: ${status}`);
  }
  const why = skipped.length > 0 ? ` (${skipped.join("; ")})` : "";
  return { stop: `No published server release found${why}. Minimums not raised.` };
}

/** Whether a tag has a GitHub release that is neither a draft nor a prerelease, through the gh CLI. */
export function publishedOnGitHub(repo) {
  return (tag) => {
    let release;
    try {
      const out = execFileSync("gh", ["release", "view", tag, "--json", "isDraft,isPrerelease"], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      release = JSON.parse(out);
    } catch (error) {
      const message = String(error.stderr ?? error.message ?? "").trim();
      if (/release not found/i.test(message)) return "no GitHub release yet";
      return { error: message.split("\n")[0] || "gh release view failed" };
    }
    if (release.isDraft) return "the GitHub release is a draft";
    if (release.isPrerelease) return "the GitHub release is a prerelease";
    return true;
  };
}

/** What is wrong with the pending file's content, as messages; empty when nothing is. */
export function validatePending(pending) {
  if (!pending || typeof pending !== "object" || !Array.isArray(pending.entries)) {
    return ['expected an object with an "entries" array'];
  }
  const errors = [];
  pending.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;
    if (!entry || typeof entry !== "object") return errors.push(`${at}: expected an object`);
    if (!TIERS.includes(entry.tier)) errors.push(`${at}.tier: expected "background" or "blocking"`);
    if (typeof entry.reason !== "string" || !entry.reason.trim())
      errors.push(`${at}.reason: expected text`);
    if (!Number.isInteger(entry.pr) || entry.pr <= 0)
      errors.push(`${at}.pr: expected the iOS PR number`);
    if (typeof entry.server !== "string" || !/^(#\d+|[0-9a-f]{7,40})$/.test(entry.server)) {
      errors.push(`${at}.server: expected the server PR ("#1234") or commit SHA`);
    }
    const known = new Set(["tier", "reason", "pr", "server"]);
    for (const key of Object.keys(entry))
      if (!known.has(key)) errors.push(`${at}.${key}: unknown field`);
  });
  return errors;
}

/** The two minimums as the Swift source declares them. */
export function readMinimums(swift) {
  const read = (name) => {
    const match = new RegExp(`static let ${name} = "([^"]+)"`).exec(swift);
    if (!match) throw new Error(`${GATE_PATH} has no ${name}`);
    return match[1];
  };
  return {
    blocking: read("blockingMinimumInstanceVersion"),
    background: read("minimumInstanceVersion"),
  };
}

export function writeMinimums(swift, { blocking, background }) {
  return swift
    .replace(/(static let blockingMinimumInstanceVersion = ")[^"]+(")/, `$1${blocking}$2`)
    .replace(/(static let minimumInstanceVersion = ")[^"]+(")/, `$1${background}$2`);
}

/**
 * The new minimums for `entries` against `release` (a tag), or the reason to
 * stop. `contains(server)` says whether the release contains an entry's
 * server change: true, false, or a message when the change cannot be found.
 * A minimum never goes down.
 */
export function plan({ entries, release, current, contains }) {
  if (entries.length === 0) return { stop: null, next: current, unchanged: true };
  if (!release)
    return {
      stop: "No server release tag (v1.*) found. Fetch the tags, or release the server first.",
    };
  const missing = [];
  for (const entry of entries) {
    const found = contains(entry.server);
    if (found === true) continue;
    missing.push(found === false ? `${entry.server} (${entry.reason})` : found);
  }
  if (missing.length > 0) {
    return {
      stop: `Release the server first: ${release} does not contain ${missing.join("; ")}.`,
    };
  }
  const version = release.replace(/^v/, "");
  const raise = (from) => (compareVersions(version, from) > 0 ? version : from);
  const background = raise(current.background);
  const blocking = entries.some((entry) => entry.tier === "blocking")
    ? raise(current.blocking)
    : current.blocking;
  return { stop: null, next: { blocking, background }, unchanged: false };
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Whether `tag` contains a server change: a commit SHA, or a PR by the "(#1234)" its squash commit ends with. */
export function containsInRepo(repo, tag) {
  return (server) => {
    let sha = server;
    if (server.startsWith("#")) {
      const found = git(repo, ["log", "--all", "-F", `--grep=(${server})`, "--format=%H"])
        .split("\n")
        .filter(Boolean);
      if (found.length === 0) return `${server} (no commit on any fetched branch mentions it)`;
      sha = found.at(-1);
    } else {
      try {
        git(repo, ["cat-file", "-e", `${server}^{commit}`]);
      } catch {
        return `${server} (no such commit; fetch, or check the SHA)`;
      }
    }
    try {
      git(repo, ["merge-base", "--is-ancestor", sha, tag]);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Whether the pending file is applied: code 0 when it has no entries, 1 with
 * the entries to apply, or with what is wrong with the file.
 */
export function check(pendingText) {
  let pending;
  try {
    pending = JSON.parse(pendingText);
  } catch (error) {
    return { code: 1, message: `${PENDING_PATH} is not JSON: ${error.message}` };
  }
  const errors = validatePending(pending);
  if (errors.length > 0)
    return { code: 1, message: `${PENDING_PATH} is malformed:\n  ${errors.join("\n  ")}` };
  const { entries } = pending;
  if (entries.length === 0) return { code: 0, message: "No pending minimum changes." };
  const list = entries.map((entry) => `${entry.tier}: ${entry.reason} (#${entry.pr})`);
  return {
    code: 1,
    message: [
      `${entries.length} pending minimum change${entries.length === 1 ? "" : "s"} in ${PENDING_PATH}:`,
      ...list.map((line) => `  ${line}`),
      "Run node ios/Tools/bump-minimum.mjs first, commit what it changes, then archive again.",
    ].join("\n"),
  };
}

export function run({
  repo,
  fetch = true,
  log = console.log,
  published = publishedOnGitHub(repo),
}) {
  if (fetch) git(repo, ["fetch", "--tags", "--quiet", "origin"]);
  const pendingFile = join(repo, PENDING_PATH);
  const gateFile = join(repo, GATE_PATH);
  const pending = JSON.parse(readFileSync(pendingFile, "utf8"));
  const errors = validatePending(pending);
  if (errors.length > 0)
    return { code: 1, message: `${PENDING_PATH} is malformed:\n  ${errors.join("\n  ")}` };

  const swift = readFileSync(gateFile, "utf8");
  const current = readMinimums(swift);
  if (pending.entries.length === 0) return { code: 0, message: "No pending minimum changes." };
  const found = publishedRelease(
    git(repo, ["tag", "-l", "v1.*"]).split("\n").filter(Boolean),
    published,
  );
  if (found.stop) return { code: 1, message: found.stop };
  for (const line of found.skipped) log(`Skipped ${line}`);
  const release = found.tag;
  const result = plan({
    entries: pending.entries,
    release,
    current,
    contains: containsInRepo(repo, release),
  });
  if (result.stop) return { code: 1, message: result.stop };
  if (result.unchanged) return { code: 0, message: "No pending minimum changes." };

  writeFileSync(gateFile, writeMinimums(swift, result.next));
  writeFileSync(pendingFile, `${JSON.stringify({ entries: [] }, null, 2)}\n`);
  log(`minimumInstanceVersion: ${current.background} -> ${result.next.background}`);
  log(`blockingMinimumInstanceVersion: ${current.blocking} -> ${result.next.blocking}`);
  return {
    code: 0,
    message: `Raised to ${release}. Review and commit ${GATE_PATH} and ${PENDING_PATH}.`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    // Reads only the file it is given, so it runs in Xcode's script sandbox.
    const pendingAt = args.indexOf("--pending");
    const file =
      pendingAt >= 0
        ? args[pendingAt + 1]
        : join(git(process.cwd(), ["rev-parse", "--show-toplevel"]), PENDING_PATH);
    const { code, message } = check(readFileSync(file, "utf8"));
    (code === 0 ? console.log : console.error)(message);
    process.exit(code);
  }
  const repoAt = args.indexOf("--repo");
  const repo =
    repoAt >= 0 ? args[repoAt + 1] : git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const { code, message } = run({ repo, fetch: !args.includes("--no-fetch") });
  (code === 0 ? console.log : console.error)(message);
  process.exit(code);
}
