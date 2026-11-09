import { describe, expect, it } from "@rstest/core";
import type { ScannedImport } from "../lint/import-rules.js";
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
];

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
    const report = importsOf(imports, ["favors"]);
    expect(report.files).toEqual(["favors/a.ts", "favors/b.ts"]);
    expect(Object.fromEntries(report.outgoing)).toEqual({
      apps: [{ from: "favors/a.ts", line: 2, to: "apps/actions/state.ts" }],
      ".": [{ from: "favors/b.ts", line: 1, to: "logger.ts" }],
    });
    expect(Object.fromEntries(report.incoming)).toEqual({
      api: [{ from: "api/routes/favors.ts", line: 4, to: "favors/a.ts" }],
      ".": [{ from: "index.ts", line: 1, to: "favors/b.ts" }],
    });
    expect(report.folders).toEqual([".", "api", "apps", "chats"]);
  });

  it("takes single files and deeper folders", () => {
    const report = importsOf(imports, ["favors/a.ts"], 2);
    expect([...report.outgoing.keys()].sort()).toEqual(["apps/actions", "favors"]);
    expect([...report.incoming.keys()].sort()).toEqual(["api/routes"]);
  });
});

describe("formatImportsOf", () => {
  it("lists import sites and the folders with no import either way", () => {
    const text = formatImportsOf(importsOf(imports, ["favors"]));
    expect(text).toContain(
      "  apps: 1 import(s) in 1 file(s)\n    favors/a.ts:2 → apps/actions/state.ts",
    );
    expect(text).toContain("The set imports nothing from: api, chats");
    expect(text).toContain("Nothing in these imports the set: apps, chats");
  });
});
