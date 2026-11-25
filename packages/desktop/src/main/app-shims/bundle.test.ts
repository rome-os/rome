import { describe, expect, it, rs } from "@rstest/core";
import {
  APP_SHIM_LAUNCH_ARG,
  cdhashRequirement,
  parseCdhash,
  pngsToIcns,
  shimAppName,
  shimBundleFiles,
  shimBundleId,
  shimInfoPlist,
  shimServerName,
  signShimBundle,
} from "./bundle";

const HOME_APPS = "/Users/me/Applications";

describe("shimAppName", () => {
  const none = () => false;

  it("keeps an ordinary name", () => {
    expect(shimAppName("Recipe Box", none, HOME_APPS)).toBe("Recipe Box");
  });

  it("cleans up what a Finder file name can't carry", () => {
    expect(shimAppName("  ..a/b:c\u0007.app ", none, HOME_APPS)).toBe("a-b-c");
    expect(shimAppName(" .app ", none, HOME_APPS)).toBe("Rome App");
    expect(shimAppName("x".repeat(200), none, HOME_APPS)).toHaveLength(80);
  });

  it("never passes for an app already on this Mac", () => {
    const exists = (path: string) =>
      path === "/System/Applications/Mail.app" || path === `${HOME_APPS}/Notes2.app`;
    expect(shimAppName("Mail", exists, HOME_APPS)).toBe("Mail (Rome)");
    expect(shimAppName("Notes2", exists, HOME_APPS)).toBe("Notes2 (Rome)");
    expect(shimAppName("Recipes", exists, HOME_APPS)).toBe("Recipes");
  });
});

describe("shimInfoPlist", () => {
  const plist = shimInfoPlist({
    bundleId: shimBundleId("com.rome.desktop", "0123456789ab"),
    name: "Tom & Jerry <3",
    appId: "@me/recipes",
    host: {
      path: "/Applications/Rome.app",
      bundleId: "com.rome.desktop",
      serverName: shimServerName("com.rome.desktop"),
    },
  });

  it("names the shim and the app it asks for its windows", () => {
    expect(plist).toContain(
      "<key>CFBundleIdentifier</key>\n\t<string>com.rome.desktop.app.0123456789ab</string>",
    );
    expect(plist).toContain("<key>CFBundleExecutable</key>\n\t<string>rome-app</string>");
    expect(plist).toContain(
      "<key>ElectronAppShimHostPath</key>\n\t<string>/Applications/Rome.app</string>",
    );
    expect(plist).toContain(
      "<key>ElectronAppShimHostBundleIdentifier</key>\n\t<string>com.rome.desktop</string>",
    );
    expect(plist).toContain(
      "<key>ElectronAppShimServerName</key>\n\t<string>com.rome.desktop.apps</string>",
    );
    expect(plist).toContain(
      `<key>ElectronAppShimHostArguments</key>\n\t<array><string>${APP_SHIM_LAUNCH_ARG}</string></array>`,
    );
  });

  it("escapes the name", () => {
    expect(plist).toContain("<string>Tom &amp; Jerry &lt;3</string>");
  });
});

describe("shimServerName", () => {
  it("keeps only the characters a server name may hold", () => {
    expect(shimServerName("com.github.Electron")).toBe("com.github.Electron.apps");
    expect(shimServerName("a b/c")).toBe("a-b-c.apps");
  });
});

describe("pngsToIcns", () => {
  it("wraps each PNG in an element of its size, and skips sizes icns has none for", () => {
    const icns = pngsToIcns([
      { size: 128, png: Buffer.from("aa") },
      { size: 100, png: Buffer.from("zz") },
      { size: 512, png: Buffer.from("bbb") },
    ]);
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(icns.subarray(8, 12).toString("ascii")).toBe("ic07");
    expect(icns.readUInt32BE(12)).toBe(10);
    expect(icns.subarray(16, 18).toString()).toBe("aa");
    expect(icns.subarray(18, 22).toString("ascii")).toBe("ic09");
    expect(icns.subarray(26).toString()).toBe("bbb");
    expect(icns.length).toBe(8 + 10 + 11);
  });

  it("refuses to make an empty icon", () => {
    expect(() => pngsToIcns([{ size: 64, png: Buffer.from("a") }])).toThrow();
  });
});

describe("shimBundleFiles", () => {
  it("lays out a bundle whose executable can run", () => {
    const files = shimBundleFiles({
      plist: "<plist/>",
      executable: Buffer.from("loader"),
      icns: Buffer.from("icns"),
    });
    expect(files.map((f) => [f.path, f.mode])).toEqual([
      ["Contents/Info.plist", 0o644],
      ["Contents/PkgInfo", 0o644],
      ["Contents/MacOS/rome-app", 0o755],
      ["Contents/Resources/app.icns", 0o644],
    ]);
  });
});

describe("signShimBundle", () => {
  const CDHASH = "0123456789abcdef0123456789abcdef01234567";

  it("signs ad hoc with the hardened runtime and returns the code directory hash", async () => {
    const exec = rs.fn(async (_file: string, args: string[]) =>
      args[0] === "--display"
        ? { stdout: "", stderr: `Executable=/x\nCDHash=${CDHASH}\nSignature=adhoc\n` }
        : { stdout: "", stderr: "" },
    );
    await expect(
      signShimBundle(exec, "/tmp/A.app", "com.rome.desktop.app.x", "/tmp/e.plist"),
    ).resolves.toBe(CDHASH);
    expect(exec.mock.calls[0]).toEqual([
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--identifier",
        "com.rome.desktop.app.x",
        "--entitlements",
        "/tmp/e.plist",
        "/tmp/A.app",
      ],
    ]);
  });

  it("fails when the signature can't be read back", async () => {
    const exec = rs.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(signShimBundle(exec, "/tmp/A.app", "id", "/tmp/e.plist")).rejects.toThrow();
  });

  it("parses only a full hash, and builds the requirement from it", () => {
    expect(parseCdhash("CDHash=abc")).toBeNull();
    expect(cdhashRequirement(CDHASH)).toBe(`cdhash H"${CDHASH}"`);
    expect(() => cdhashRequirement('" or anchor apple')).toThrow();
  });
});
