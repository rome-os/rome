import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = resolve(root, "dist/native/Rome Computer Use.app");
const executable = resolve(app, "Contents/MacOS/RomeComputerUse");
const binary = readFileSync(executable);
if (
  !statSync(executable).isFile() ||
  !(statSync(executable).mode & 0o111) ||
  binary.length < 32 ||
  binary.readUInt32LE(0) !== 0xfeedfacf ||
  binary.readUInt32LE(4) !== 0x0100000c
) {
  throw new Error("The package must contain the macOS arm64 computer-use executable.");
}
const info = readFileSync(resolve(app, "Contents/Info.plist"), "utf8");
if (!/<key>CFBundleIdentifier<\/key>\s*<string>com\.rome\.computer-use<\/string>/.test(info))
  throw new Error("The packaged computer-use app has an unexpected bundle identity.");
readFileSync(resolve(app, "Contents/Resources/THIRD_PARTY_NOTICES.md"));
const implementation = JSON.parse(
  readFileSync(resolve(app, "Contents/Resources/implementation.json"), "utf8"),
);
if (
  implementation.protocolVersion !== 1 ||
  implementation.architecture !== "arm64" ||
  !/^[a-f0-9]{64}$/.test(implementation.implementationSha256)
)
  throw new Error("The packaged helper needs its signed implementation identity.");
if (implementation.buildOptions?.selfTest !== false)
  throw new Error("A native test fixture cannot be packaged as the runtime helper.");

if (process.argv.includes("--release")) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Publish node-core from an arm64 Mac with its signed native helper.");
  if (
    /<key>RomeComputerUseUnsigned<\/key>\s*<true\/>/.test(info) ||
    implementation.buildOptions?.unsigned !== false
  )
    throw new Error("An unsigned CI helper cannot be published.");
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", app]);
  const details = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", app], {
    encoding: "utf8",
  });
  if (
    details.status !== 0 ||
    !/^Authority=Developer ID Application:/m.test(details.stderr) ||
    !/^TeamIdentifier=[A-Z0-9]{10}$/m.test(details.stderr)
  )
    throw new Error("The release helper must have a Developer ID Application signature.");
  execFileSync("/usr/bin/xcrun", ["stapler", "validate", app]);
}
process.stdout.write("The Node archive contains the macOS arm64 computer-use app.\n");
