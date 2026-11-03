import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUN_AS = join(PROJECT_ROOT, "scripts/docker/rome-run-as.sh");
const SHELL_PATH = join(PROJECT_ROOT, "scripts/docker/rome-shell-path.sh");
const IMAGE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function run(command: string, args: string[], env: Record<string, string>): string {
  const result = spawnSync(command, args, { env, encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("rome-run-as PATH", () => {
  // Root mode skips gosu, so the script runs here as the invoking user.
  const runAs = (account: string, path: string) =>
    run("/bin/bash", [RUN_AS, account, "/usr/bin/printenv", "PATH"], {
      PATH: path,
      ROME_DOCKER_USER_MODE: "root",
    }).trim();

  it("appends the account's ~/.local/bin after the image's directories", () => {
    expect(runAs("rome", IMAGE_PATH)).toBe(`${IMAGE_PATH}:/home/rome/.local/bin`);
    expect(runAs("user", IMAGE_PATH)).toBe(`${IMAGE_PATH}:/home/user/.local/bin`);
  });

  it("leaves a PATH that already has the directory unchanged", () => {
    const path = `/home/rome/.local/bin:${IMAGE_PATH}`;
    expect(runAs("rome", path)).toBe(path);
  });
});

describe("rome-shell-path.sh", () => {
  const source = (path: string) =>
    run("/bin/sh", ["-c", '. "$1"; . "$1"; printf %s "$PATH"', "sh", SHELL_PATH], {
      HOME: "/home/rome",
      PATH: path,
    });

  it("appends ~/.local/bin once, however often a shell sources it", () => {
    expect(source("/usr/local/bin:/usr/bin:/bin")).toBe(
      "/usr/local/bin:/usr/bin:/bin:/home/rome/.local/bin",
    );
  });

  it("moves the directory after the others when a profile put it first", () => {
    expect(source("/home/rome/.local/bin:/usr/bin:/home/rome/.local/bin:/bin")).toBe(
      "/usr/bin:/bin:/home/rome/.local/bin",
    );
  });

  it("gives an empty PATH only the directory, with no empty entry", () => {
    expect(source("")).toBe("/home/rome/.local/bin");
  });
});

describe("rome-init.sh ensure_npm_prefix", () => {
  const initSource = readFileSync(join(PROJECT_ROOT, "scripts/docker/rome-init.sh"), "utf8");
  const helper = initSource.match(/^ensure_npm_prefix\(\) \{\n[\s\S]*?^}\n/m)?.[0];
  if (!helper) throw new Error("ensure_npm_prefix not found in rome-init.sh");
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rome-npm-prefix-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // Stands in for rome-init's gosu wrapper: runs the command with the account's HOME.
  const ensure = () =>
    run(
      "/bin/bash",
      [
        "-c",
        `run_as_account() { HOME="$2" "\${@:3}"; }\n${helper}\nensure_npm_prefix rome "$1"`,
        "ensure",
        home,
      ],
      { PATH: process.env.PATH ?? "" },
    );
  const npmrc = () => readFileSync(join(home, ".npmrc"), "utf8");

  it("creates ~/.npmrc with a prefix under the home directory", () => {
    ensure();
    expect(npmrc()).toBe(`prefix=${home}/.local\n`);
  });

  it("adds the prefix after existing settings, on its own line", () => {
    writeFileSync(join(home, ".npmrc"), "//registry.example.com/:_authToken=abc");
    ensure();
    ensure();
    expect(npmrc()).toBe(`//registry.example.com/:_authToken=abc\nprefix=${home}/.local\n`);
  });

  it("keeps a prefix the account already set", () => {
    writeFileSync(join(home, ".npmrc"), "prefix = /opt/custom\n");
    ensure();
    expect(npmrc()).toBe("prefix = /opt/custom\n");
  });
});
