import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const nativeEnvironment = { ...process.env };
delete nativeEnvironment.DEVELOPER_DIR;
delete nativeEnvironment.SDKROOT;
delete nativeEnvironment.TOOLCHAINS;
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function run(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, {
    env: nativeEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr || result.error || result.status}`);
  return result.stdout + result.stderr;
}

if (process.platform !== "darwin")
  throw new Error("The computer-use helper must be built on macOS.");
// The project's Nix shell supplies Node, while the selected Xcode supplies macOS native tools.
nativeEnvironment.DEVELOPER_DIR = run("/usr/bin/xcode-select", ["-p"]).trim();
const sdkPath = run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]).trim();
nativeEnvironment.SDKROOT = sdkPath;
const requestedOutput = resolve(
  option("--output") ?? resolve(root, "dist/native/Rome Computer Use.app"),
);
mkdirSync(dirname(requestedOutput), { recursive: true });
const canonicalParent = realpathSync(dirname(requestedOutput));
const output = resolve(canonicalParent, basename(requestedOutput));
const identity =
  option("--identity") ??
  process.env.ROME_COMPUTER_USE_SIGNING_IDENTITY ??
  process.env.CODE_SIGN_IDENTITY ??
  process.env.CSC_NAME;
const unsigned = args.includes("--unsigned");
const selfTest = args.includes("--self-test-build");
const buildOptions = { selfTest, unsigned, swiftVersion: "5", minimumMacOS: "14.0" };
if (unsigned && option("--identity"))
  throw new Error(
    "Choose --unsigned for compile-only checks or --identity for a permission-capable build.",
  );
if (!unsigned && (!identity || identity === "-"))
  throw new Error(
    "Pass --identity with a stable Apple code-signing identity. Ad-hoc signing cannot retain privacy permissions across builds.",
  );
const build = option("--build-number") ?? "1";
if (!/^\d+(?:\.\d+)*$/.test(build))
  throw new Error("--build-number must contain numeric version components.");
// Store the lock beside the canonical output parent so symlink aliases and separate checkouts share one lock.
const lockDirectory = resolve(
  canonicalParent,
  `.rome-computer-use-build-lock-${createHash("sha256").update(output).digest("hex").slice(0, 16)}`,
);
try {
  mkdirSync(lockDirectory, { mode: 0o700 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  throw new Error(
    `Computer-use build output is locked: ${output}. Lock: ${lockDirectory}. Check its owner before moving a stale lock to Trash.`,
  );
}
const lockOwner = resolve(lockDirectory, "owner.json");
const releaseLock = () => {
  try {
    unlinkSync(lockOwner);
  } catch {}
  try {
    rmdirSync(lockDirectory);
  } catch {}
};
process.once("exit", releaseLock);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    releaseLock();
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  });
}
writeFileSync(lockOwner, JSON.stringify({ pid: process.pid, output }), { mode: 0o600 });
const contents = resolve(output, "Contents");
const executable = resolve(contents, "MacOS/RomeComputerUse");
mkdirSync(dirname(executable), { recursive: true });
const native = resolve(root, "native");
const sourceNames = readdirSync(native)
  .filter((name) => /\.(swift|c|h)$/.test(name))
  .sort();
const sources = sourceNames.map((name) => ({ name, bytes: readFileSync(resolve(native, name)) }));
const pointerIcon = readFileSync(
  resolve(root, "../../ios/Rome/Assets.xcassets/LaunchLogo.imageset/launch-logo-dark.svg"),
  "utf8",
).replace(/(fill|stroke)="#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})"/gi, (_, paint, r, g, b) => {
  const tint = [r, g, b]
    .map((channel) => Math.round(0.4 * Number.parseInt(channel, 16) + 0.6 * 255).toString(16))
    .join("");
  return `${paint}="#${tint}"`;
});
const implementationHash = createHash("sha256");
implementationHash.update(JSON.stringify(buildOptions)).update("\0");
implementationHash.update("pointer-robot.svg\0").update(pointerIcon).update("\0");
for (const source of sources)
  implementationHash.update(source.name).update("\0").update(source.bytes).update("\0");
const implementationSha256 = implementationHash.digest("hex");
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`;
const outputKey = createHash("sha256").update(output).digest("hex").slice(0, 12);
const objectDirectory = resolve(
  root,
  "../..",
  ".scratch/computer-use-objects",
  process.arch,
  outputKey,
);
mkdirSync(objectDirectory, { recursive: true });
// Compile the exact bytes fingerprinted above even if the working tree changes during a build.
for (const source of sources) writeFileSync(resolve(objectDirectory, source.name), source.bytes);
const buildIdentity = resolve(objectDirectory, "NativeBuildIdentity.generated.swift");
writeFileSync(
  buildIdentity,
  `enum NativeBuildIdentity { static let implementationSha256 = "${implementationSha256}"; static let architecture = "${process.arch}" }\n`,
);
const swift = sourceNames
  .filter((name) => name.endsWith(".swift"))
  .map((name) => resolve(objectDirectory, name));
const c = sourceNames.filter((name) => name.endsWith(".c"));
const objects = c.map((name) => {
  const object = resolve(objectDirectory, `${name}.o`);
  run("/usr/bin/clang", [
    "-target",
    target,
    "-isysroot",
    sdkPath,
    "-c",
    resolve(objectDirectory, name),
    "-o",
    object,
  ]);
  return object;
});
const header = sourceNames.find((name) => name.endsWith(".h"));
run("/usr/bin/swiftc", [
  "-sdk",
  sdkPath,
  "-swift-version",
  "5",
  "-parse-as-library",
  ...(unsigned ? ["-D", "ROME_COMPUTER_USE_UNSIGNED"] : []),
  ...(selfTest ? ["-D", "ROME_COMPUTER_USE_SELF_TEST"] : []),
  "-O",
  "-target",
  target,
  ...(header ? ["-import-objc-header", resolve(objectDirectory, header)] : []),
  ...swift,
  buildIdentity,
  ...objects,
  "-o",
  executable,
  "-framework",
  "AppKit",
  "-framework",
  "ApplicationServices",
  "-framework",
  "ScreenCaptureKit",
]);
writeFileSync(
  resolve(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.rome.computer-use</string>
<key>CFBundleName</key><string>Rome Computer Use</string>
<key>CFBundleDisplayName</key><string>Rome Computer Use</string>
<key>CFBundleExecutable</key><string>RomeComputerUse</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>${build}</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>RomeComputerUseUnsigned</key><${unsigned ? "true" : "false"}/>
<key>RomeComputerUseImplementationSHA256</key><string>${implementationSha256}</string>
<key>NSScreenCaptureUsageDescription</key><string>Rome captures the screens you authorize so your agent can observe and verify its work.</string>
</dict></plist>\n`,
);
mkdirSync(resolve(contents, "Resources"), { recursive: true });
writeFileSync(resolve(contents, "Resources/pointer-robot.svg"), pointerIcon);
writeFileSync(
  resolve(contents, "Resources/implementation.json"),
  JSON.stringify({
    protocolVersion: 1,
    implementationSha256,
    architecture: process.arch,
    buildOptions,
  }) + "\n",
);
copyFileSync(
  resolve(native, "THIRD_PARTY_NOTICES.md"),
  resolve(contents, "Resources/THIRD_PARTY_NOTICES.md"),
);
if (!unsigned) {
  run("/usr/bin/codesign", [
    "--force",
    "--sign",
    identity!,
    "--identifier",
    "com.rome.computer-use",
    "--options",
    "runtime",
    output,
  ]);
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", output]);
  const requirement = run("/usr/bin/codesign", ["--display", "--requirements", "-", output]);
  process.stdout.write(`${output}\n${requirement}`);
} else {
  process.stdout.write(
    `${output}\nUNSIGNED: compile-only artifact. Permission requests and computer-use operations are disabled.\n`,
  );
}
