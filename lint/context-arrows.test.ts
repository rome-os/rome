import { describe, expect, it } from "@rstest/core";
import { contextArrows, formatContextArrows } from "./context-arrows.js";
import type { ScannedImport } from "./import-rules.js";

const file = (from: string, to: string, line = 1): ScannedImport => ({
  line,
  from,
  specifier: "./x.js",
  kind: "file",
  to,
});

const imports: ScannedImport[] = [
  file("favors/a.ts", "favors/b.ts"),
  file("favors/a.ts", "apps/state.ts", 2),
  file("favors/b.ts", "logger.ts"),
  file("favors/b.ts", "../package.json"),
  { line: 3, from: "favors/b.ts", specifier: "zod", kind: "package" },
  file("api/routes/favors.ts", "favors/a.ts", 4),
  file("index.ts", "favors/b.ts"),
  file("chats/c.ts", "chats/d.ts"),
  file("apps/state.ts", "chats/c.ts"),
  file("lib/visitor.ts", "apps/state.ts"),
];

describe("contextArrows", () => {
  it("groups the imports crossing a context folder by the context on the other side", () => {
    const arrows = contextArrows(imports, ["favors"]);
    expect(arrows.name).toBe("favors");
    expect(arrows.files).toEqual(["favors/a.ts", "favors/b.ts"]);
    expect(Object.fromEntries(arrows.outgoing)).toEqual({
      apps: [{ from: "favors/a.ts", line: 2, to: "apps/state.ts" }],
      "src root": [{ from: "favors/b.ts", line: 1, to: "logger.ts" }],
    });
    expect(Object.fromEntries(arrows.incoming)).toEqual({
      api: [{ from: "api/routes/favors.ts", line: 4, to: "favors/a.ts" }],
      "src root": [{ from: "index.ts", line: 1, to: "favors/b.ts" }],
    });
    expect(arrows.others).toEqual(["api", "apps", "chats", "lib"]);
  });

  it("treats loose files as one set, named by --as, with the files already in that folder", () => {
    const arrows = contextArrows(imports, ["lib/visitor.ts", "apps/state.ts"], "favors");
    expect(arrows.name).toBe("favors");
    expect(arrows.files).toEqual(["apps/state.ts", "favors/a.ts", "favors/b.ts", "lib/visitor.ts"]);
    expect([...arrows.outgoing.keys()].sort()).toEqual(["chats", "src root"]);
    expect([...arrows.incoming.keys()].sort()).toEqual(["api", "src root"]);
  });

  it("names loose files from several contexts <set> when no --as is given", () => {
    expect(contextArrows(imports, ["lib/visitor.ts", "apps/state.ts"]).name).toBe("<set>");
  });
});

describe("formatContextArrows", () => {
  it("proposes a rule for each direction, split by whether crossings remain", () => {
    const report = formatContextArrows(contextArrows(imports, ["favors"]));
    expect(report).toContain("  apps: 1 import(s) in 1 file(s)\n    favors/a.ts:2 → apps/state.ts");
    expect(report).toContain(
      "Rules that hold today, with no crossing to fix:\n  favors never imports: api, chats, lib\n  never import favors: apps, chats, lib",
    );
    expect(report).toContain(
      "Rules that hold once their crossings are fixed or listed:\n  favors never imports: apps (1)\n  never import favors: api (1)",
    );
  });

  it("leaves out a rule lint/rules/contexts.ts already has", () => {
    const agent = [file("agent/a.ts", "chats/c.ts"), file("connections/x.ts", "chats/c.ts")];
    const report = formatContextArrows(contextArrows(agent, ["agent"]));
    expect(report).toContain("  agent never imports: none\n");
    expect(report).toContain(
      "Rules already in lint/rules/contexts.ts:\n  agent never imports apps",
    );
  });
});
