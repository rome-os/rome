import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "@rstest/core";
import { checkImports, formatImportViolation } from "./import-rules.js";
import { contextRules } from "./rules/contexts.js";
import { layerRules } from "./rules/layers.js";

const root = mkdtempSync(join(tmpdir(), "import-rules-"));

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

write("package.json", JSON.stringify({ type: "module" }));
write(
  "tsconfig.json",
  JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      paths: { "@/*": ["./src/*"] },
    },
  }),
);
write("src/logger.ts", "export const log = 1;\n");
write("src/agent/index.ts", 'export * from "./domain/session.js";\n');
write("src/agent/domain/session.ts", "export type Session = { id: string };\n");
write("src/agent/application/use.ts", "export const use = 1;\n");
write("src/agent/infrastructure/model/adapter.ts", "export const adapter = 1;\n");
write(
  "src/agent/domain/probe.ts",
  [
    'import "./session.js";',
    'import "zod";',
    'import "../index.js";',
    'import "@/logger.js";',
    'type T = import("../../logger.js").X;',
    'import "./x/../../infrastructure/model/adapter.js";',
    "const name = 'x'; void import(name);",
  ].join("\n"),
);
write(
  "src/agent/application/sub/probe.ts",
  [
    'import "../../domain/session.js";',
    'import "../use.js";',
    'import "../../infrastructure/model/adapter.js";',
  ].join("\n"),
);
write(
  "src/agent/infrastructure/model/probe.ts",
  [
    'import "../../domain/session.js";',
    'import "@/logger.js";',
    'import "../../index.js";',
    'import "../../../agent/./application/use.js";',
  ].join("\n"),
);
write(
  "src/concierge/probe.ts",
  [
    'import "../agent/index.js";',
    'import "../agent/./domain/session.js";',
    'export * from "@/agent//infrastructure/model/adapter.js";',
    'import "../agent/domain/nope.js";',
  ].join("\n"),
);

write("src/apps/catalog.ts", "export type AppCatalog = { size: number };\n");
write(
  "src/agent/infrastructure/apps-probe.ts",
  ['import type { AppCatalog } from "../../apps/catalog.js";', 'import "@/apps/catalog.js";'].join(
    "\n",
  ),
);
write("src/routines/agent-probe.ts", 'import "../agent/index.js";\n');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("checkImports with the layer rules", () => {
  it("judges each import by the file it resolves to", () => {
    const lines = checkImports(join(root, "src"), join(root, "tsconfig.json"), layerRules)
      .map(formatImportViolation)
      .map((line) => line.replace(/: .*$/, ""));
    expect(lines).toEqual([
      "agent/application/sub/probe.ts:3 → ../../infrastructure/model/adapter.js (agent/infrastructure/model/adapter.ts) [application-imports-inward]",
      "agent/domain/probe.ts:3 → ../index.js (agent/index.ts) [domain-imports-domain]",
      "agent/domain/probe.ts:4 → @/logger.js (logger.ts) [domain-imports-domain]",
      "agent/domain/probe.ts:5 → ../../logger.js (logger.ts) [domain-imports-domain]",
      "agent/domain/probe.ts:6 → ./x/../../infrastructure/model/adapter.js (agent/infrastructure/model/adapter.ts) [domain-imports-domain]",
      "agent/domain/probe.ts:7 → <computed> [literal-imports-in-contexts]",
      "agent/infrastructure/model/probe.ts:3 → ../../index.js (agent/index.ts) [infrastructure-imports-inward]",
      "agent/infrastructure/model/probe.ts:4 → ../../../agent/./application/use.js (agent/application/use.ts) [infrastructure-imports-inward]",
      "concierge/probe.ts:2 → ../agent/./domain/session.js (agent/domain/session.ts) [enter-through-index]",
      "concierge/probe.ts:3 → @/agent//infrastructure/model/adapter.js (agent/infrastructure/model/adapter.ts) [enter-through-index]",
      "concierge/probe.ts:4 → ../agent/domain/nope.js [unresolved]",
    ]);
  });

  it("skips a listed crossing and reports a listed crossing that no longer occurs", () => {
    const crossing = (from: string, to: string) => ({
      rule: "application-imports-inward",
      from,
      to,
      ticket: "ZHA-0",
      why: "fixture",
    });
    const lines = checkImports(join(root, "src"), join(root, "tsconfig.json"), layerRules, [
      crossing("agent/application/sub/probe.ts", "agent/infrastructure/model/adapter.ts"),
      crossing("agent/application/use.ts", "logger.ts"),
    ])
      .map(formatImportViolation)
      .map((line) => line.replace(/: .*$/, ""))
      .filter((line) => line.startsWith("agent/application/"));
    expect(lines).toEqual(["agent/application/use.ts → logger.ts [stale-listing]"]);
  });
});

describe("checkImports with the context rules", () => {
  it("rejects every import from agent/ into apps/, type-only included, and allows one a context may make", () => {
    const lines = checkImports(join(root, "src"), join(root, "tsconfig.json"), contextRules)
      .map(formatImportViolation)
      .map((line) => line.replace(/: .*$/, ""))
      .filter((line) => !line.includes("[unresolved]"));
    expect(lines).toEqual([
      "agent/infrastructure/apps-probe.ts:1 → ../../apps/catalog.js (apps/catalog.ts) [agent-never-imports-apps]",
      "agent/infrastructure/apps-probe.ts:2 → @/apps/catalog.js (apps/catalog.ts) [agent-never-imports-apps]",
    ]);
  });
});
