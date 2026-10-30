import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createAction as createEdit } from "../actions/edit-memory-file/index.js";
import { createAction as createList } from "../actions/list-memory-files/index.js";
import { createAction as createRead } from "../actions/read-memory-file/index.js";
import { createAction as createWrite } from "../actions/write-memory-file/index.js";
import type { MemoryFileDeps } from "../actions/write-memory-file/index.js";
import { fileChangesFromToolUse } from "./changes.js";

const changesFromToolUse = (...args: Parameters<typeof fileChangesFromToolUse>) =>
  fileChangesFromToolUse(...args).changes;

const config = {
  name: "write_memory_file",
  type: "custom",
  description: "",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "write",
} as const;

let root: string;
let memory: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-dir-"));
  memory = join(root, "memory");
  outside = join(root, "apps");
  mkdirSync(memory);
  mkdirSync(outside);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = () => ({ memoryDir: memory }) as unknown as AppActionRuntimeDeps<MemoryFileDeps>;

describe("memory file actions", () => {
  it("writes and edits files inside the memory directory", async () => {
    const write = createWrite(config, deps());
    const edit = createEdit({ ...config, name: "edit_memory_file" }, deps());

    expect(
      await write.execute({ path: join(memory, "topics/a.md"), content: "one two" }),
    ).toMatchObject({ status: "ok" });
    expect(
      await edit.execute({
        path: join(memory, "topics/a.md"),
        old_string: "two",
        new_string: "three",
      }),
    ).toMatchObject({ status: "ok" });
    expect(readFileSync(join(memory, "topics/a.md"), "utf8")).toBe("one three");
  });

  it("refuses paths that lead out of the memory directory", async () => {
    const write = createWrite(config, deps());
    symlinkSync(outside, join(memory, "link"));

    // A dangling link to a file outside memory.
    symlinkSync(join(outside, "dangling.md"), join(memory, "dangling.md"));
    const errors: string[] = [];
    for (const path of [
      join(outside, "x.ts"),
      "topics/a.md",
      join(memory, "../apps/x.ts"),
      join(memory, "link/x.ts"),
      join(memory, "dangling.md"),
      join(memory, ".git/config"),
    ]) {
      const result = await write.execute({ path, content: "planted" });
      expect(result.status).toBe("error");
      if (result.status === "error") errors.push(result.error);
    }
    expect(() => readFileSync(join(outside, "x.ts"))).toThrow();
    expect(() => readFileSync(join(outside, "dangling.md"))).toThrow();
    // Errors never repeat the agent's path, which could carry injected text.
    expect(errors.some((error) => error.includes("x.ts") || error.includes("dangling"))).toBe(
      false,
    );
  });

  it("refuses an edit whose text is missing or not unique", async () => {
    writeFileSync(join(memory, "MEMORY.md"), "a a");
    const edit = createEdit({ ...config, name: "edit_memory_file" }, deps());

    expect(
      (await edit.execute({ path: "MEMORY.md", old_string: "a", new_string: "b" })).status,
    ).toBe("error");
    expect(
      (await edit.execute({ path: "MEMORY.md", old_string: "z", new_string: "b" })).status,
    ).toBe("error");
  });

  it("lists and reads memory, and nothing outside it", async () => {
    writeFileSync(join(memory, "MEMORY.md"), "index");
    mkdirSync(join(memory, ".git"));
    writeFileSync(join(memory, ".git/config"), "[core]");
    const list = createList({ ...config, name: "list_memory_files" }, deps());
    const read = createRead({ ...config, name: "read_memory_file" }, deps());

    const listed = (await list.execute({})) as { data: { files: string } };
    expect(listed.data.files).toBe(join(memory, "MEMORY.md"));
    expect(await read.execute({ path: join(memory, "MEMORY.md") })).toMatchObject({
      data: { content: "index" },
    });
    expect((await read.execute({ path: join(outside, "x") })).status).toBe("error");
    expect((await list.execute({ path: outside })).status).toBe("error");
  });

  it("records the actions' calls as the file changes they make", () => {
    const path = join(memory, "MEMORY.md");
    expect(
      changesFromToolUse("execute_action", {
        action_name: "dream:edit_memory_file",
        json_args: { path, old_string: "a", new_string: "b" },
      }),
    ).toEqual([{ op: "edit", path, content: "b", previous: "a", truncated: false }]);
    expect(
      changesFromToolUse("execute_action", {
        action_name: "write_memory_file",
        json_args: { path, content: "c" },
      }),
    ).toEqual([{ op: "write", path, content: "c", previous: null, truncated: false }]);
  });
});

describe("recording memory actions", () => {
  it("drops a refused call whatever shape the provider gives its result", async () => {
    const { RunRecorder } = await import("./run-recorder.js");
    const added: unknown[] = [];
    const repo = { addChanges: (_id: string, changes: unknown[]) => added.push(...changes) };
    const refused = '{"status":"error","error":"The file does not exist"}';
    const outputs = [
      refused,
      [{ type: "text", text: refused }],
      { content: [{ type: "text", text: refused }] },
    ];
    outputs.forEach((output, i) => {
      const recorder = new RunRecorder(repo as never, "run");
      recorder.observe({
        type: "tool_use",
        id: `t${i}`,
        tool: "execute_action",
        input: { action_name: "write_memory_file", json_args: { path: "/m/a.md", content: "x" } },
      } as never);
      recorder.observe({
        type: "tool_result",
        toolUseId: `t${i}`,
        tool: "execute_action",
        output,
      } as never);
    });
    expect(added).toEqual([]);
  });
});
