import { describe, expect, it } from "@rstest/core";
import type { ImportScan, ScannedImport } from "../lint/import-rules.js";
import { folderOf, formatImportsOf, importsOf } from "./imports-of.js";

const file = (from: string, to: string, line = 1): ScannedImport => ({
  line,
  from,
  specifier: "./x.js",
  kind: "file",
  to,
});

const imports: ScannedImport[] = [
  file("favors/a.ts", "favors/b.ts"),
  file("favors/a.ts", "apps/actions/state.ts", 2),
  file("favors/b.ts", "logger.ts"),
  file("favors/b.ts", "../package.json"),
  { line: 3, from: "favors/b.ts", specifier: "zod", kind: "package" },
  file("api/routes/favors.ts", "favors/a.ts", 4),
  file("index.ts", "favors/b.ts"),
  file("chats/c.ts", "chats/d.ts"),
  { line: 5, from: "favors/b.ts", specifier: "./gone.js", kind: "unresolved" },
];

const scan: ImportScan = {
  files: [
    "api/routes/favors.ts",
    "apps/actions/state.ts",
    "build-info.ts",
    "chats/c.ts",
    "chats/d.ts",
    "favors/a.ts",
    "favors/b.ts",
    "favors/constants.ts",
    "index.ts",
    "logger.ts",
    "people/isolated.ts",
  ],
  imports,
};

describe("folderOf", () => {
  it("cuts a path to its folder at the given depth, or the deepest folder above it", () => {
    expect(folderOf("api/routes/x.ts", 1)).toBe("api");
    expect(folderOf("api/routes/x.ts", 2)).toBe("api/routes");
    expect(folderOf("api/x.ts", 2)).toBe("api");
    expect(folderOf("index.ts", 1)).toBe(".");
  });
});

describe("importsOf", () => {
  it("groups the imports crossing the set by the folder on the other side", () => {
    const report = importsOf(scan, ["favors"]);
    expect(report.files).toEqual(["favors/a.ts", "favors/b.ts", "favors/constants.ts"]);
    expect(Object.fromEntries(report.outgoing)).toEqual({
      apps: [{ from: "favors/a.ts", line: 2, to: "apps/actions/state.ts" }],
      ".": [{ from: "favors/b.ts", line: 1, to: "logger.ts" }],
    });
    expect(Object.fromEntries(report.incoming)).toEqual({
      api: [{ from: "api/routes/favors.ts", line: 4, to: "favors/a.ts" }],
      ".": [{ from: "index.ts", line: 1, to: "favors/b.ts" }],
    });
    expect(report.folders).toEqual([".", "api", "apps", "chats", "people"]);
    expect(report.unresolved).toEqual([{ from: "favors/b.ts", line: 5, specifier: "./gone.js" }]);
  });

  it("counts a selected file that imports nothing", () => {
    const report = importsOf(scan, ["build-info.ts"]);
    expect(report.files).toEqual(["build-info.ts"]);
    expect(report.outgoing.size).toBe(0);
  });

  it("takes single files and deeper folders", () => {
    const report = importsOf(scan, ["favors/a.ts"], 2);
    expect([...report.outgoing.keys()].sort()).toEqual(["apps/actions", "favors"]);
    expect([...report.incoming.keys()].sort()).toEqual(["api/routes"]);
  });
});

describe("formatImportsOf", () => {
  it("lists import sites and the folders with no import either way", () => {
    const text = formatImportsOf(importsOf(scan, ["favors"]));
    expect(text).toContain(
      "  apps: 1 import(s) in 1 file(s)\n    favors/a.ts:2 → apps/actions/state.ts",
    );
    expect(text).toContain("The set imports nothing from: api, chats, people");
    expect(text).toContain("Nothing in these imports the set: apps, chats, people");
    expect(text).toContain(
      "1 import(s) in the set do not resolve and are not counted:\n  favors/b.ts:5 → ./gone.js",
    );
  });
});
