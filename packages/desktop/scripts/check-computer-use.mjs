import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import { Arch } from "electron-builder";

const appName = "Rome Computer Use.app";
const helper = fileURLToPath(
  new URL(`../../rome-node-core-darwin-arm64/dist/native/${appName}`, import.meta.url),
);
const verifier = fileURLToPath(
  new URL("../../rome-node-core/scripts/computer-use.swift", import.meta.url),
);

function shipsHelper({ arch, appOutDir, electronPlatformName, outDir, packager }) {
  // Universal builds also run an arm64 pack in a temporary output directory.
  return (
    electronPlatformName === "darwin" &&
    arch === Arch.arm64 &&
    appOutDir === packager.computeAppOutDir(outDir, arch)
  );
}

function checkHelper() {
  const flags =
    process.env.ROME_DESKTOP_ALLOW_UNSIGNED_COMPUTER_USE === "1" ? ["--self-test-build"] : [];
  try {
    execFileSync("/usr/bin/swift", [verifier, "verify", "--app", helper, ...flags], {
      stdio: "inherit",
    });
  } catch (cause) {
    throw new Error(
      [
        "Build the signed helper from the repository root with this command.",
        "  swift packages/rome-node-core/scripts/computer-use.swift build --app 'packages/rome-node-core-darwin-arm64/dist/native/Rome Computer Use.app' --identity '<identity>'",
        "For local unsigned packaging, replace the --identity option and its value with --self-test-build. Set ROME_DESKTOP_ALLOW_UNSIGNED_COMPUTER_USE=1 when packaging.",
      ].join("\n"),
      { cause },
    );
  }
}

export function checkTemplatePermissions(
  path,
  executable = join(path, "Contents/MacOS/RomeComputerUse"),
) {
  const info = lstatSync(path);
  const directory = info.isDirectory();
  assert.ok(directory || info.isFile(), `Expected a regular file or directory: ${path}`);
  const required = directory || path === executable || (info.mode & 0o111) !== 0 ? 0o555 : 0o444;
  assert.equal(
    info.mode & required,
    required,
    `Helper template requires a+${required === 0o555 ? "rx" : "r"}: ${path}`,
  );
  if (directory) {
    for (const name of readdirSync(path)) checkTemplatePermissions(join(path, name), executable);
  }
}

export function beforePack(context) {
  if (shipsHelper(context)) checkHelper();
}

export function afterPack(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const platformPackage = "node_modules/@rome-os/node-core-darwin-arm64";
  assert.ok(!existsSync(join(resources, "app.asar.unpacked", platformPackage)));
  assert.ok(
    !listPackage(join(resources, "app.asar")).some((entry) => {
      const path = entry.replaceAll("\\", "/");
      return path.includes(platformPackage) || path.split("/").includes(appName);
    }),
    "The platform helper must stay outside app.asar.",
  );

  const destination = join(resources, "native", appName);
  assert.ok(!existsSync(destination), "The Helper must come from the arm64 pack hook.");
  if (shipsHelper(context)) {
    execFileSync("/usr/bin/ditto", [helper, destination], { stdio: "inherit" });
    checkTemplatePermissions(destination);
  }
}
