import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  execFileSync("/usr/bin/swift", [verifier, "verify", "--app", helper, ...flags], {
    stdio: "inherit",
  });
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
  }
}
