import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "@rstest/core";
import { checkLayerBoundaries, formatLayerViolation } from "./layer-boundaries.js";

const root = mkdtempSync(join(tmpdir(), "layer-boundaries-"));

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

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("checkLayerBoundaries", () => {
  it("judges each import by the file it resolves to", () => {
    const lines = checkLayerBoundaries(join(root, "src"), join(root, "tsconfig.json"), ["agent"])
      .map(formatLayerViolation)
      .map((line) => line.replace(/: .*$/, ""));
    expect(lines).toEqual([
      "agent/application/sub/probe.ts:3 → ../../infrastructure/model/adapter.js (agent/infrastructure/model/adapter.ts) (rule 2)",
      "agent/domain/probe.ts:3 → ../index.js (agent/index.ts) (rule 1)",
      "agent/domain/probe.ts:4 → @/logger.js (logger.ts) (rule 1)",
      "agent/domain/probe.ts:5 → ../../logger.js (logger.ts) (rule 1)",
      "agent/domain/probe.ts:6 → ./x/../../infrastructure/model/adapter.js (agent/infrastructure/model/adapter.ts) (rule 1)",
      "agent/domain/probe.ts:7 → <computed> (rule unchecked)",
      "agent/infrastructure/model/probe.ts:3 → ../../index.js (agent/index.ts) (rule 3)",
      "agent/infrastructure/model/probe.ts:4 → ../../../agent/./application/use.js (agent/application/use.ts) (rule 3)",
      "concierge/probe.ts:2 → ../agent/./domain/session.js (agent/domain/session.ts) (rule 4)",
      "concierge/probe.ts:3 → @/agent//infrastructure/model/adapter.js (agent/infrastructure/model/adapter.ts) (rule 4)",
      "concierge/probe.ts:4 → ../agent/domain/nope.js (rule unchecked)",
    ]);
  });
});
