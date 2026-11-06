import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import {
  type BoundaryViolation,
  baselineEntryOf,
  checkAgentBoundaries,
  compareWithBaseline,
} from "./boundary-check.js";

// A src tree in miniature. Each path is relative to the scanned src directory.
const FIXTURE: Record<string, string> = {
  "index.ts": `import { Adapter } from "./agent/index.js";
new Adapter();
`,
  "core/x.ts": `export type X = number;
`,
  "agent/index.ts": `export { type Port } from "./domain/port.js";
export { Adapter } from "./infrastructure/adapter.js";
export * from "./infrastructure/star.js";
`,
  "agent/domain/port.ts": `export interface Port { run(): void }
`,
  "agent/domain/reaches-out.ts": `import type { X } from "../../core/x.js";
export type Y = X;
`,
  "agent/application/use-case.ts": `import type { Port } from "../domain/port.js";
export { Adapter } from "../infrastructure/adapter.js";
`,
  "agent/infrastructure/adapter.ts": `import type { Port } from "../domain/port.js";
import type { X } from "../../core/x.js";
export class Adapter implements Port { run() {} }
`,
  "agent/infrastructure/star.ts": `import type { Port } from "../index.js";
export class StarAdapter {}
`,
  "agent/domain/quoted.ts": `export const single = 'import { X } from "../../core/in-single.js";';
export const double = "export * from '../../core/in-double.js'";
export const template = \`import("../../core/in-template.js") \${\`import "../../core/in-nested.js"\`} \${{ a: 1 }.a}\`;
import type { X } from "../../core/after-strings.js";
`,
  "agent/domain/regex-class.ts": `export const wildcard = /[/*]/;
import type { X } from "../../core/after-regex-class.js";
`,
  "agent/domain/division.ts": `const a = 8, b = 4, c = 2;
export const ratio = a / b / c;
import type { X } from "../../core/after-division.js";
`,
  "agent/domain/regex-quotes.ts": `export const quotes = /"'\`/;
export const url = /https?:\\/\\/[^/]+/g;
export const hidden = /import "..\\/..\\/core\\/in-regex.js"/;
import type { X } from "../../core/after-regex-quotes.js";
`,
  "outside/reach-in.ts": `import type { Port } from "../agent/domain/port.js";
`,
  "outside/alias.ts": `import type { Port } from "@/agent/infrastructure/adapter.js";
`,
  "outside/uses-adapter.ts": `import { Adapter } from "../agent/index.js";
`,
  "outside/star-adapter.ts": `import { StarAdapter } from "../agent";
`,
  "outside/namespace.ts": `import * as agent from "../agent/index.js";
`,
  "outside/type-port.ts": `export type P = import("../agent/index.js").Port;
`,
  "outside/type-adapter.ts": `export type A = import("../agent/index.js").Adapter;
`,
  "outside/bare-dynamic.ts": `export const load = () => import("../agent/index.js");
`,
  "outside/then-dynamic.ts": `export const load = () => import("../agent/index.js").then((agent) => agent);
`,
  "outside/clean.ts": `import type { Port } from "../agent/index.js";
`,
  "outside/adapter.test.ts": `import { Adapter } from "../agent/index.js";
import type { Port } from "../agent/domain/port.js";
`,
};

const EXPECTED = [
  "agent/application/use-case.ts → ../infrastructure/adapter.js (rule 2)",
  "agent/domain/division.ts → ../../core/after-division.js (rule 1)",
  "agent/domain/quoted.ts → ../../core/after-strings.js (rule 1)",
  "agent/domain/reaches-out.ts → ../../core/x.js (rule 1)",
  "agent/domain/regex-class.ts → ../../core/after-regex-class.js (rule 1)",
  "agent/domain/regex-quotes.ts → ../../core/after-regex-quotes.js (rule 1)",
  "agent/infrastructure/star.ts → ../index.js (rule 3)",
  "outside/alias.ts → @/agent/infrastructure/adapter.js (rule 4)",
  "outside/bare-dynamic.ts → ../agent/index.js (rule 5)",
  "outside/namespace.ts → ../agent/index.js (rule 5)",
  "outside/reach-in.ts → ../agent/domain/port.js (rule 4)",
  "outside/star-adapter.ts → ../agent (rule 5)",
  "outside/then-dynamic.ts → ../agent/index.js (rule 5)",
  "outside/type-adapter.ts → ../agent/index.js (rule 5)",
  "outside/uses-adapter.ts → ../agent/index.js (rule 5)",
];

function violation(file: string, specifier: string): BoundaryViolation {
  return { file, specifier, rule: 1, reason: "fixture" };
}

describe("checkAgentBoundaries", () => {
  let srcDir = "";

  beforeAll(() => {
    srcDir = mkdtempSync(join(tmpdir(), "agent-boundary-"));
    for (const [path, content] of Object.entries(FIXTURE)) {
      mkdirSync(dirname(join(srcDir, path)), { recursive: true });
      writeFileSync(join(srcDir, path), content);
    }
  });

  afterAll(() => {
    rmSync(srcDir, { recursive: true, force: true });
  });

  it("reports exactly the crossings in the fixture tree", () => {
    const found = checkAgentBoundaries(srcDir).map((v) => `${baselineEntryOf(v)} (rule ${v.rule})`);
    expect([...found].sort()).toEqual([...EXPECTED].sort());
  });
});

describe("compareWithBaseline", () => {
  it("separates listed, stale and unlisted entries", () => {
    const listed = violation("agent/domain/a.ts", "../../core/a.js");
    const unlisted = violation("agent/domain/b.ts", "../../core/b.js");
    const baseline = `# header

agent/domain/a.ts → ../../core/a.js
  outside/gone.ts → ../agent/domain/port.js
`;
    expect(compareWithBaseline([listed, unlisted], baseline)).toEqual({
      unlisted: [unlisted],
      stale: ["outside/gone.ts → ../agent/domain/port.js"],
    });
  });
});
