import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const output = resolve(repo, ".scratch/desktop-controller/Native Test.app");
const environment = { ...process.env };
delete environment.SDKROOT;
delete environment.DEVELOPER_DIR;
delete environment.TOOLCHAINS;
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", env: environment });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
environment.DEVELOPER_DIR = run("/usr/bin/xcode-select", ["-p"]);
const sdk = run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
mkdirSync(resolve(output, "Contents/MacOS"), { recursive: true });
run("/usr/bin/swiftc", [
  "-sdk",
  sdk,
  "-swift-version",
  "5",
  "-parse-as-library",
  resolve(repo, "packages/rome-node-core/native/tests/DesktopFixture.swift"),
  "-o",
  resolve(output, "Contents/MacOS/DesktopFixture"),
  "-framework",
  "AppKit",
]);
writeFileSync(
  resolve(output, "Contents/Info.plist"),
  `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.rome.desktop-controller.fixture</string><key>CFBundleName</key><string>Rome Desktop Controller Test</string><key>CFBundleExecutable</key><string>DesktopFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
);
run("/usr/bin/codesign", ["--force", "--sign", "-", output]);
console.log(output);
