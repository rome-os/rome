/**
 * Place better-sqlite3's native addon at native/better_sqlite3.node.
 *
 * better-sqlite3 13 is a Node-API addon and ships prebuilt binaries in its
 * package, so the same file loads in system Node.js and in any Electron
 * version. The packaged app reads it from native/ (see electron-builder.yml),
 * and database.ts passes this path via the `nativeBinding` option.
 * macOS release builds can request a universal binding with
 * ROME_DESKTOP_NATIVE_ARCH=universal.
 */
import { execSync } from "child_process";
import { cpSync, mkdirSync, existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const nativeDir = resolve(root, "native");
const bindingPath = resolve(nativeDir, "better_sqlite3.node");
const metadataPath = resolve(nativeDir, "better_sqlite3.meta.json");
const require = createRequire(import.meta.url);

function getSqlitePackageDir() {
  try {
    const sqlitePkg = require.resolve("better-sqlite3/package.json");
    return dirname(realpathSync(sqlitePkg));
  } catch {
    console.error("Cannot find better-sqlite3. Run pnpm install first.");
    process.exit(1);
  }
}

function getSqliteVersion() {
  return require("better-sqlite3/package.json").version;
}

function requestedArch() {
  return process.env.ROME_DESKTOP_NATIVE_ARCH || process.arch;
}

function readBindingMetadata() {
  if (!existsSync(bindingPath) || !existsSync(metadataPath)) return null;
  try {
    return JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    return null;
  }
}

function isBindingCurrent() {
  const metadata = readBindingMetadata();
  return Boolean(
    metadata &&
      metadata.sqliteVersion === getSqliteVersion() &&
      metadata.arch === requestedArch() &&
      metadata.platform === process.platform,
  );
}

function prebuildFor(sqlitePkgDir, arch) {
  const file = resolve(sqlitePkgDir, "prebuilds", `${process.platform}-${arch}.node`);
  if (!existsSync(file)) {
    console.error(`better-sqlite3 ships no prebuilt binary for ${process.platform}-${arch}.`);
    process.exit(1);
  }
  return file;
}

export function ensureBetterSqlite3Binding() {
  const sqliteVersion = getSqliteVersion();
  const arch = requestedArch();
  if (isBindingCurrent()) {
    console.log(
      `Native binding up to date: better_sqlite3.node (better-sqlite3 ${sqliteVersion}, ${arch})`,
    );
    return false;
  }

  const sqlitePkgDir = getSqlitePackageDir();
  mkdirSync(nativeDir, { recursive: true });
  if (arch === "universal") {
    if (process.platform !== "darwin") {
      console.error("Universal native bindings are only supported on macOS.");
      process.exit(1);
    }
    const x64 = prebuildFor(sqlitePkgDir, "x64");
    const arm64 = prebuildFor(sqlitePkgDir, "arm64");
    execSync(`lipo -create -output "${bindingPath}" "${x64}" "${arm64}"`, { stdio: "inherit" });
  } else {
    cpSync(prebuildFor(sqlitePkgDir, arch), bindingPath);
  }

  writeFileSync(
    metadataPath,
    JSON.stringify({ sqliteVersion, arch, platform: process.platform }, null, 2) + "\n",
  );
  console.log(`Done: native/better_sqlite3.node (better-sqlite3 ${sqliteVersion}, ${arch})`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureBetterSqlite3Binding();
}
