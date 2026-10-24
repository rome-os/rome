import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { slugify } from "./gc-stack-guard.js";

const script = join(dirname(fileURLToPath(import.meta.url)), "worktree-slug.sh");

// A throwaway repo, so the test does not depend on the checkout it runs in:
// CI checks out a detached HEAD, and the dev container has no .git at all.
let repo: string;

function git(...args: string[]): void {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function slug(romeDevSlug?: string) {
  const env = { ...process.env };
  delete env.ROME_DEV_SLUG;
  if (romeDevSlug !== undefined) env.ROME_DEV_SLUG = romeDevSlug;
  const r = spawnSync("bash", [script], { cwd: repo, env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "Worktree Slug "));
  git("init", "-q", "-b", "Feature/Pinned_Stack");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("worktree-slug.sh", () => {
  it("names the stack after the branch when unset or empty", () => {
    expect(slug()).toMatchObject({ status: 0, stdout: "feature-pinned-stack\n" });
    expect(slug("")).toMatchObject({ status: 0, stdout: "feature-pinned-stack\n" });
  });

  it("names the stack after the checkout directory on a detached HEAD", () => {
    git("checkout", "-q", "--detach");
    try {
      expect(slug()).toMatchObject({ status: 0, stdout: `${slugify(basename(repo))}\n` });
    } finally {
      git("checkout", "-q", "Feature/Pinned_Stack");
    }
  });

  it("uses ROME_DEV_SLUG under the same rule as the TypeScript slugify", () => {
    for (const value of ["rome", "Eric Dev/1"]) {
      expect(slug(value)).toMatchObject({ status: 0, stdout: `${slugify(value)}\n` });
    }
  });

  it("fails loudly when ROME_DEV_SLUG sanitizes to nothing", () => {
    for (const value of ["!!!", "_"]) {
      const r = slug(value);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("ROME_DEV_SLUG");
    }
  });

  it("refuses the names of the shared singleton stacks", () => {
    for (const value of ["rome-traefik", "Rome Obs", "obs", "clickhouse", "otlp"]) {
      const r = slug(value);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("shared Rome stack");
    }
  });
});
