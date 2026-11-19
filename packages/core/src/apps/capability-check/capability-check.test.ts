import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { readApp } from "./read-app.js";
import { checkApp, type RuleId } from "./rules.js";

const DESCRIPTION = "Keeps a list of notes the guardian can add to, read and remove.";

const ACTION = (name: string, body: string, extra = "") => ({
  [`src/actions/${name}/action.yaml`]: `name: ${name}
type: custom
description: Does ${name}.
complexity: simple
speed: fast
reliability: high
sideEffects: write
${extra}`,
  [`src/actions/${name}/index.ts`]: body,
});

const SCHEMA_ACTION = `
export function createAction(config: unknown) {
  return {
    config,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The note." } },
    },
    execute: async () => ({ status: "ok" }),
  };
}
`;

const COMPLIANT: Record<string, string> = {
  "app.yaml": `formatVersion: 1
id: notes
name: Notes
version: 0.1.0
description: ${DESCRIPTION}
appRoot: dist
web:
  manifest: web/manifest.json
api:
  entry: api/index
actions:
  - actions/add_note
`,
  ...ACTION("add_note", SCHEMA_ACTION),
  "src/db/notes.ts":
    "export function createNotesRepository(db: unknown) { return { insert: async (t: string) => t }; }\n",
  "src/api/index.ts": `
export class Handler {
  constructor(private readonly ctx: { runAction(name: string, input: unknown): Promise<unknown> }) {}
  async handle(request: { method: string; path: string[] }) {
    const route = request.path.join("/");
    if (request.method === "GET" && request.path.length === 0) return "ok";
    if (request.method === "POST" && route === "notes") return this.add();
    return "not found";
  }
  private async add() {
    return this.ctx.runAction("add_note", { text: "x" });
  }
}
`,
  "src/web/App.tsx": `import { fetchAppApi } from "@rome-os/app-web-sdk";\nexport const save = () => fetchAppApi("notes", { method: "POST" });\n`,
};

const dirs: string[] = [];

function writeApp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "capability-check-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

async function gapsOf(
  files: Record<string, string>,
): Promise<Array<{ rule: RuleId; at: string; message: string }>> {
  const verdict = checkApp(await readApp(writeApp(files)));
  return verdict.gaps.map(({ rule, at, message }) => ({ rule, at, message }));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("capability check", () => {
  it("finds no gap in an app whose page and agents share one action", async () => {
    expect(await gapsOf(COMPLIANT)).toEqual([]);
  });

  it("D1: reports a description too short to tell an agent anything", async () => {
    const gaps = await gapsOf({
      ...COMPLIANT,
      "app.yaml": (COMPLIANT["app.yaml"] as string).replace(DESCRIPTION, "Notes."),
    });
    expect(gaps.map((g) => g.rule)).toEqual(["D1"]);
  });

  it("D2: reports a public action without an input schema, and spares an explicit one", async () => {
    const noSchema =
      "export function createAction(config: unknown) { return { config, execute: async () => ({}) }; }\n";
    const manifest = `${COMPLIANT["app.yaml"]}  - actions/sweep\n  - actions/tidy\n`;
    const gaps = await gapsOf({
      ...COMPLIANT,
      "app.yaml": manifest,
      ...ACTION("sweep", noSchema),
      ...ACTION("tidy", noSchema, "visibility: explicit\n"),
    });
    expect(gaps).toEqual([expect.objectContaining({ rule: "D2", at: "src/actions/sweep" })]);
  });

  it("D3: reports undescribed arguments, in JSON Schema and in zod", async () => {
    const jsonSchema = SCHEMA_ACTION.replace(
      '{ type: "string", description: "The note." }',
      '{ type: "string" }',
    );
    const zod = `import { z } from "zod";
const schema = z.object({ text: z.string().describe("The note."), tag: z.string() }).strict();
export function createAction(config: unknown) { return defineAction({ config, schema, execute: async () => ({}) }); }
declare function defineAction(spec: unknown): unknown;
`;
    const gaps = await gapsOf({
      ...COMPLIANT,
      "app.yaml": `${COMPLIANT["app.yaml"]}  - actions/tag_note\n`,
      ...ACTION("add_note", jsonSchema),
      ...ACTION("tag_note", zod),
      "src/api/index.ts": (COMPLIANT["src/api/index.ts"] as string).replace(
        'return this.ctx.runAction("add_note", { text: "x" });',
        'await this.ctx.runAction("tag_note", {});\n    return this.ctx.runAction("add_note", { text: "x" });',
      ),
    });
    expect(gaps.map((g) => [g.rule, g.message])).toEqual([
      ["D3", "`add_note` leaves `text` undescribed."],
      ["D3", "`tag_note` leaves `tag` undescribed."],
    ]);
  });

  it("I1 and I3: reports a route that writes data itself and runs no action", async () => {
    const api = (COMPLIANT["src/api/index.ts"] as string)
      .replace(
        'return "not found";',
        `if (request.method === "DELETE" && request.path[0] === "notes" && request.path.length === 2) {
      return createNotesRepository(null).insert("gone");
    }
    return "not found";`,
      )
      .replace(
        "export class",
        'import { createNotesRepository } from "../db/notes.js";\nexport class',
      );
    const gaps = await gapsOf({ ...COMPLIANT, "src/api/index.ts": api });
    expect(gaps.map((g) => [g.rule, g.message])).toEqual([
      [
        "I3",
        "`DELETE /notes/:id` writes app data itself (`createNotesRepository(null).insert`), so an agent cannot make the same change.",
      ],
      ["I1", "`DELETE /notes/:id` runs no action, so no agent can do what it does."],
    ]);
  });

  it("I1: spares machine routes declared noAuth", async () => {
    const api = (COMPLIANT["src/api/index.ts"] as string).replace(
      'return "not found";',
      'if (request.method === "POST" && route === "webhook") return "ack";\n    return "not found";',
    );
    const manifest = (COMPLIANT["app.yaml"] as string).replace(
      "  entry: api/index\n",
      "  entry: api/index\n  noAuth:\n    - /webhook\n",
    );
    expect(await gapsOf({ ...COMPLIANT, "app.yaml": manifest, "src/api/index.ts": api })).toEqual(
      [],
    );
  });

  it("I2: reports an agent-callable action no route runs", async () => {
    const gaps = await gapsOf({
      ...COMPLIANT,
      "app.yaml": `${COMPLIANT["app.yaml"]}  - actions/archive_note\n`,
      ...ACTION("archive_note", SCHEMA_ACTION),
    });
    expect(gaps).toEqual([expect.objectContaining({ rule: "I2", at: "src/actions/archive_note" })]);
  });

  it("I4: reports an action that imports the API, and an API that imports an action", async () => {
    const gaps = await gapsOf({
      ...COMPLIANT,
      "src/api/helpers.ts": "export const x = 1;\n",
      "src/actions/add_note/index.ts": `import { x } from "../../api/helpers.js";\n${SCHEMA_ACTION}`,
      "src/api/index.ts": `import "../actions/add_note/index.js";\n${COMPLIANT["src/api/index.ts"]}`,
    });
    expect(gaps.map((g) => [g.rule, g.at])).toEqual([
      ["I4", "src/actions/add_note/index.ts:1"],
      ["I4", "src/api/index.ts:1"],
    ]);
  });

  it("I5: reports a page that fetches past its app API", async () => {
    const gaps = await gapsOf({
      ...COMPLIANT,
      "src/web/App.tsx": 'export const load = () => fetch("/api/skills");\n',
    });
    expect(gaps.map((g) => [g.rule, g.at])).toEqual([["I5", "src/web/App.tsx:1"]]);
  });

  it("reports an API whose routes it cannot read instead of passing it", async () => {
    const gaps = await gapsOf({
      ...COMPLIANT,
      "src/api/index.ts": "export const handle = (r: unknown) => r;\n",
    });
    expect(gaps.map((g) => g.rule)).toContain("I1");
  });
});
