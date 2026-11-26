import { execFile } from "child_process";
import { join } from "path";
import { promisify } from "util";

/**
 * The small app bundle that puts one Rome app on the Desktop under its own name
 * and icon. Its executable is Electron's `app_shim_loader`, which loads this
 * app's Electron framework and asks this app for its windows (Electron's app
 * shims): the window shows in the Dock, the app switcher and the menu bar as
 * the Rome app, while this app still renders it.
 *
 * Everything here is plain data and file work, so it is tested without Electron.
 */

/** The executable's name inside `Contents/MacOS`. */
const SHIM_EXECUTABLE = "rome-app";
/** Passed when a shim has to launch this app, which then keeps its main window hidden. */
export const APP_SHIM_LAUNCH_ARG = "--app-shim-launch";

export interface ShimPlistInput {
  bundleId: string;
  name: string;
  appId: string;
  host: { path: string; bundleId: string; serverName: string };
}

/** The shim's bundle id: this app's id plus the install's own suffix. */
export function shimBundleId(hostBundleId: string, installId: string): string {
  return `${hostBundleId}.app.${installId}`;
}

/** The bundle id in an Info.plist Rome wrote, or null for anything else (a missing or binary plist). */
export function plistBundleId(plist: string | null): string | null {
  if (!plist) return null;
  return (
    /<key>CFBundleIdentifier<\/key>\s*<string>([A-Za-z0-9.-]+)<\/string>/.exec(plist)?.[1] ?? null
  );
}

/**
 * The saved bundle paths that still hold the bundle Rome made there: its
 * Info.plist names that record's bundle id. A path the user has since given
 * to something else is not Rome's to replace.
 */
export function ownedShimPaths(
  records: Array<{ installId: string; bundlePath: string }>,
  hostBundleId: string,
  readPlist: (bundlePath: string) => string | null,
): Set<string> {
  return new Set(
    records
      .filter(
        (r) => plistBundleId(readPlist(r.bundlePath)) === shimBundleId(hostBundleId, r.installId),
      )
      .map((r) => r.bundlePath),
  );
}

/** `<name>.app` in `dir`, or `<name> 2.app`… when that one is not Rome's to replace. */
export function shimDestination(
  dir: string,
  name: string,
  ours: Set<string>,
  exists: (path: string) => boolean,
): string {
  for (let n = 1; ; n += 1) {
    const candidate = join(dir, `${n === 1 ? name : `${name} ${n}`}.app`);
    if (!exists(candidate) || ours.has(candidate)) return candidate;
  }
}

/** The app server name shims connect to; one per host bundle id, so a dev build never answers a release's shims. */
export function shimServerName(hostBundleId: string): string {
  return `${hostBundleId}.apps`.replace(/[^A-Za-z0-9._-]/g, "-");
}

const KNOWN_APP_DIRS = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
];

/**
 * The bundle's file name and shown name. A name a Finder file cannot carry is
 * cleaned up, and one that matches an app already on this Mac (Safari,
 * Mail…) gets " (Rome)" so a Rome app never passes for it.
 */
export function shimAppName(
  displayName: string,
  appExists: (path: string) => boolean,
  homeApplications: string,
): string {
  const cleaned =
    displayName
      .normalize("NFC")
      // Control characters have no place in a file name.
      .replace(/\p{Cc}/gu, "")
      .replace(/[/:]/g, "-")
      .trim()
      .replace(/(\.app)+$/i, "")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 80)
      .trim() || "Rome App";
  const dirs = [...KNOWN_APP_DIRS, homeApplications];
  const taken = dirs.some((dir) => appExists(`${dir}/${cleaned}.app`));
  return taken ? `${cleaned} (Rome)` : cleaned;
}

function escapeXml(value: string): string {
  return value
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The shim's Info.plist: who it is, and which app it asks for its windows. */
export function shimInfoPlist(input: ShimPlistInput): string {
  const entries: Array<[string, string | boolean | string[]]> = [
    ["CFBundleIdentifier", input.bundleId],
    ["CFBundleName", input.name],
    ["CFBundleDisplayName", input.name],
    ["CFBundleExecutable", SHIM_EXECUTABLE],
    ["CFBundleIconFile", "app"],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleInfoDictionaryVersion", "6.0"],
    ["CFBundleShortVersionString", "1.0"],
    ["CFBundleVersion", "1"],
    ["LSMinimumSystemVersion", "13.0"],
    ["NSHighResolutionCapable", true],
    ["NSPrincipalClass", "NSApplication"],
    ["ElectronAppShimHostPath", input.host.path],
    ["ElectronAppShimHostBundleIdentifier", input.host.bundleId],
    ["ElectronAppShimServerName", input.host.serverName],
    ["ElectronAppShimHostArguments", [APP_SHIM_LAUNCH_ARG]],
    ["RomeAppId", input.appId],
  ];
  const value = (v: string | boolean | string[]): string => {
    if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
    if (typeof v === "string") return `<string>${escapeXml(v)}</string>`;
    return `<array>${v.map((item) => `<string>${escapeXml(item)}</string>`).join("")}</array>`;
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries.map(([key, v]) => `\t<key>${key}</key>\n\t${value(v)}`),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * The one entitlement the shim needs. Its own signature is ad hoc, so the
 * hardened runtime would otherwise refuse this app's framework, which is
 * signed by this app's team.
 */
export const SHIM_ENTITLEMENTS = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  "<dict>",
  "\t<key>com.apple.security.cs.disable-library-validation</key>",
  "\t<true/>",
  "</dict>",
  "</plist>",
  "",
].join("\n");

/** An icns element type for a PNG of this many pixels a side. */
const ICNS_TYPES: Record<number, string> = { 128: "ic07", 256: "ic08", 512: "ic09", 1024: "ic10" };

/**
 * An .icns file made of PNG images, which macOS reads as they are: no
 * conversion and no tool needed. Sizes it has no element type for are skipped.
 */
export function pngsToIcns(images: Array<{ size: number; png: Buffer }>): Buffer {
  const elements = images
    .filter((image) => ICNS_TYPES[image.size])
    .map((image) => {
      const header = Buffer.alloc(8);
      header.write(ICNS_TYPES[image.size], 0, "ascii");
      header.writeUInt32BE(8 + image.png.length, 4);
      return Buffer.concat([header, image.png]);
    });
  if (elements.length === 0) throw new Error("No icon image of a size an icns file holds.");
  const body = Buffer.concat(elements);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

/** The files of a shim bundle, by path inside it. */
export function shimBundleFiles(input: {
  plist: string;
  executable: Buffer;
  icns: Buffer;
}): Array<{ path: string; data: Buffer; mode: number }> {
  return [
    { path: "Contents/Info.plist", data: Buffer.from(input.plist), mode: 0o644 },
    { path: "Contents/PkgInfo", data: Buffer.from("APPL????"), mode: 0o644 },
    { path: `Contents/MacOS/${SHIM_EXECUTABLE}`, data: input.executable, mode: 0o755 },
    { path: "Contents/Resources/app.icns", data: input.icns, mode: 0o644 },
  ];
}

export type ExecFile = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export const execFileAsync: ExecFile = promisify(execFile) as unknown as ExecFile;

const CODESIGN = "/usr/bin/codesign";

/**
 * Signs the bundle ad hoc with the hardened runtime, and returns its code
 * directory hash. That hash is what a connecting shim must match: any process
 * of this user can connect to the app server, but only this bundle has it.
 */
export async function signShimBundle(
  exec: ExecFile,
  bundlePath: string,
  bundleId: string,
  entitlementsPath: string,
): Promise<string> {
  await exec(CODESIGN, [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--identifier",
    bundleId,
    "--entitlements",
    entitlementsPath,
    bundlePath,
  ]);
  // codesign prints the details on stderr.
  const { stdout, stderr } = await exec(CODESIGN, ["--display", "--verbose=3", bundlePath]);
  const cdhash = parseCdhash(`${stderr}\n${stdout}`);
  if (!cdhash) throw new Error("The app was signed, but its signature could not be read.");
  return cdhash;
}

export function parseCdhash(output: string): string | null {
  return /^CDHash=([0-9a-f]{40})$/m.exec(output)?.[1] ?? null;
}

/** The code requirement a connecting shim must satisfy. */
export function cdhashRequirement(cdhash: string): string {
  if (!/^[0-9a-f]{40}$/.test(cdhash)) throw new Error("Not a code directory hash.");
  return `cdhash H"${cdhash}"`;
}
