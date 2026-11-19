import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { readApp } from "./read-app.js";
import { renderReport } from "./report.js";
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

  it("I2: does not count a route as a person's way in when the app has no page", async () => {
    const manifest = (COMPLIANT["app.yaml"] as string).replace(
      "web:\n  manifest: web/manifest.json\n",
      "",
    );
    const { "src/web/App.tsx": _page, ...rest } = COMPLIANT;
    const gaps = await gapsOf({ ...rest, "app.yaml": manifest });
    expect(gaps.map((g) => [g.rule, g.at])).toEqual([["I2", "src/actions/add_note"]]);
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

  describe("never passes what it cannot read", () => {
    const withRoute = (route: string, imports = "") => ({
      ...COMPLIANT,
      "src/api/index.ts": `${imports}${COMPLIANT["src/api/index.ts"] as string}`.replace(
        'return "not found";',
        `${route}\n    return "not found";`,
      ),
    });

    async function verdictOf(files: Record<string, string>) {
      return checkApp(await readApp(writeApp(files)));
    }

    it("leaves a route on a subject it does not know to a person, not to the root exemption", async () => {
      const verdict = await verdictOf(
        withRoute(
          'const parts = request.path;\n    if (request.method === "GET" && parts[0] === "items") return "items";',
        ),
      );
      expect(verdict.gaps).toEqual([]);
      expect(verdict.unverified.map((u) => u.message)).toEqual([
        expect.stringContaining("a path test the reader cannot follow"),
      ]);
    });

    it("leaves a pattern-matched route and a switch dispatch to a person", async () => {
      const verdict = await verdictOf(
        withRoute(
          `if (/^items\\/\\d+$/.test(route) && request.method === "GET") return "item";
    switch (route) {
      case "other":
        return "other";
    }`,
        ),
      );
      expect(verdict.unverified).toHaveLength(2);
    });

    it("judges code that runs after a nested method check", async () => {
      const gaps = await gapsOf(
        withRoute(
          `if (route === "notes/bulk") {
      if (request.method === "GET") return this.add();
      return createNotesRepository(null).insert("many");
    }`,
          'import { createNotesRepository } from "../db/notes.js";\n',
        ),
      );
      expect(gaps.map((g) => [g.rule, g.message])).toEqual([
        ["I3", expect.stringContaining("`ANY /notes/bulk` writes app data itself")],
        ["I1", "`ANY /notes/bulk` runs no action, so no agent can do what it does."],
      ]);
    });

    it("keeps an indexed path segment at its index", async () => {
      const gaps = await gapsOf(
        withRoute(
          'if (request.method === "POST" && request.path[0] === "notes" && request.path[2] === "pin" && request.path.length === 3) return "pinned";',
        ),
      );
      expect(gaps.map((g) => g.message)).toEqual([
        "`POST /notes/:id/pin` runs no action, so no agent can do what it does.",
      ]);
    });

    it("leaves a schema built by spreading another to a person", async () => {
      const spread = SCHEMA_ACTION.replace(
        'inputSchema: {\n      type: "object",',
        'inputSchema: {\n      ...base,\n      type: "object",',
      ).replace("export function", "const base = {};\nexport function");
      const verdict = await verdictOf({ ...COMPLIANT, ...ACTION("add_note", spread) });
      expect(verdict.gaps).toEqual([]);
      expect(verdict.unverified.map((u) => [u.rule, u.message])).toEqual([
        ["D3", "Could not read the input schema of `add_note`."],
      ]);
    });

    it("judges a zod field by its own description, through names", async () => {
      const zod = `import { z } from "zod";
const text = z.string().describe("The note.");
const schema = z.object({ text, items: z.array(z.object({ x: z.string().describe("x") })) });
export function createAction(config: unknown) { return defineAction({ config, schema, execute: async () => ({}) }); }
declare function defineAction(spec: unknown): unknown;
`;
      const gaps = await gapsOf({ ...COMPLIANT, ...ACTION("add_note", zod) });
      expect(gaps.map((g) => g.message)).toEqual(["`add_note` leaves `items` undescribed."]);
    });

    it("leaves a route matched only by a pattern to a person", async () => {
      const verdict = await verdictOf(
        withRoute(
          'if (/^erase$/.test(route)) return createNotesRepository(null).insert("x");',
          'import { createNotesRepository } from "../db/notes.js";\n',
        ),
      );
      expect(verdict.gaps).toEqual([]);
      expect(verdict.unverified.map((u) => u.rule)).toEqual(["I1"]);
    });

    it("does not take a zod meta without a description as one", async () => {
      const zod = (field: string) => `import { z } from "zod";
const schema = z.object({ text: z.string().meta(${field}) });
export function createAction(config: unknown) { return defineAction({ config, schema, execute: async () => ({}) }); }
declare function defineAction(spec: unknown): unknown;
declare const extra: unknown;
`;
      const titled = await verdictOf({
        ...COMPLIANT,
        ...ACTION("add_note", zod('{ title: "Note" }')),
      });
      expect(titled.gaps.map((g) => g.message)).toEqual(["`add_note` leaves `text` undescribed."]);
      const opaque = await verdictOf({ ...COMPLIANT, ...ACTION("add_note", zod("extra")) });
      expect(opaque.gaps).toEqual([]);
      expect(opaque.unverified.map((u) => u.rule)).toEqual(["D3"]);
    });

    it("finds a request the page makes through a shared helper", async () => {
      const gaps = await gapsOf({
        ...COMPLIANT,
        "src/lib/network.ts": 'export const load = () => fetch("/api/skills");\n',
        "src/web/App.tsx": 'import { load } from "../lib/network.js";\nexport const go = load;\n',
      });
      expect(gaps.map((g) => [g.rule, g.at])).toEqual([["I5", "src/lib/network.ts:1"]]);
    });
  });

  it("I3: finds a write through the SDK's Drizzle handle in a store outside the data folder", async () => {
    const api = (COMPLIANT["src/api/index.ts"] as string)
      .replace(
        'return this.ctx.runAction("add_note", { text: "x" });',
        'await clearNotes(this.ctx as never);\n    return this.ctx.runAction("add_note", { text: "x" });',
      )
      .replace("export class", 'import { clearNotes } from "./store.js";\nexport class');
    const gaps = await gapsOf({
      ...COMPLIANT,
      "src/api/index.ts": api,
      "src/api/store.ts":
        "export async function clearNotes(ctx: { db: { connection: { delete(t: unknown): unknown } } }) {\n  return ctx.db.connection.delete({});\n}\n",
    });
    expect(gaps.map((g) => [g.rule, g.message])).toEqual([
      ["I3", expect.stringContaining("(`ctx.db.connection.delete`)")],
    ]);
  });

  it("I2: does not count a machine route as a person's way to run an action", async () => {
    const api = (COMPLIANT["src/api/index.ts"] as string).replace(
      'return "not found";',
      'if (request.method === "POST" && route === "webhook") return this.ctx.runAction("archive_note", {});\n    return "not found";',
    );
    const manifest = `${(COMPLIANT["app.yaml"] as string).replace("  entry: api/index\n", "  entry: api/index\n  noAuth:\n    - /webhook\n")}  - actions/archive_note\n`;
    const gaps = await gapsOf({
      ...COMPLIANT,
      "app.yaml": manifest,
      "src/api/index.ts": api,
      ...ACTION("archive_note", SCHEMA_ACTION),
    });
    expect(gaps.map((g) => [g.rule, g.at])).toEqual([["I2", "src/actions/archive_note"]]);
  });

  it("report: does not say a rule holds while part of it is left to a person", async () => {
    const report = renderReport([
      checkApp(
        await readApp(
          writeApp({
            ...COMPLIANT,
            "src/api/index.ts": (COMPLIANT["src/api/index.ts"] as string).replace(
              'return "not found";',
              'switch (route) {\n      case "other":\n        return "other";\n    }\n    return "not found";',
            ),
          }),
        ),
      ),
    ]);
    expect(report).toContain("| notes | ✓ | ✓ | ✓ | ? |");
    expect(report).toContain("### I1: 1 left for a person to judge");
    expect(report).toContain("### I2: holds");
  });
});
