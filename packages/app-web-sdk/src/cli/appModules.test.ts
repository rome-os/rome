import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { loadActionModules, loadApiFactory, readAppOnDisk } from "./appModules.js";

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

const ACTION_YAML = (name: string, entry?: string) =>
  `name: ${name}\ntype: custom\ndescription: ${name}\n${entry ? `entry: ${entry}\n` : ""}complexity: simple\nspeed: fast\nreliability: high\nsideEffects: read-only\n`;

describe("app modules", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rome-modules-"));
    write(
      root,
      "app.yaml",
      [
        "formatVersion: 2",
        "id: demo-app",
        "version: 0.1.0",
        "description: Demo",
        "appRoot: dist",
        "api:",
        "  entry: api/index",
        "actions:",
        "  - actions/named",
        "  - actions/pascal",
        "",
      ].join("\n"),
    );
    // Written against the source name, as the template's action.yaml is.
    write(root, "dist/actions/named/action.yaml", ACTION_YAML("named", "./index.ts"));
    write(
      root,
      "dist/actions/named/index.js",
      "export function createAction(config) { return { config, execute: async () => ({ status: 'ok' }) }; }\n",
    );
    write(root, "dist/actions/pascal/action.yaml", ACTION_YAML("look_up"));
    write(
      root,
      "dist/actions/pascal/index.js",
      "export function createLookUpAction(config) { return { config }; }\n",
    );
    write(
      root,
      "dist/api/index.js",
      "export function createApiHandler() { return { handle: async () => new Response('ok') }; }\n",
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("resolves action factories the way the host does", async () => {
    const app = await readAppOnDisk(join(root, "dist"));
    const actions = await loadActionModules(app);

    // app.yaml declares no db.tablePrefix, so the host falls back to the raw id.
    expect(app.tablePrefix).toBe("demo-app");
    expect(actions.map((a) => a.config.name)).toEqual(["named", "look_up"]);
    expect(typeof (await loadApiFactory(app))).toBe("function");
  });

  it("names the action whose module exports no factory", async () => {
    write(root, "dist/actions/pascal/index.js", "export const unrelated = 1;\n");
    const app = await readAppOnDisk(root);

    await expect(loadActionModules(app)).rejects.toThrow(/No action factory found for "look_up"/);
  });
});
