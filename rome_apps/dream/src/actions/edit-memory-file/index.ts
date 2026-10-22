import { readFile, writeFile } from "node:fs/promises";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { profileMemoryDir, resolveMemoryFile } from "../../lib/memory-dir.js";
import type { MemoryFileDeps } from "../write-memory-file/index.js";

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<MemoryFileDeps>,
): Action {
  const memoryDir = deps.memoryDir ?? profileMemoryDir();
  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path of the file, inside the memory directory",
        },
        old_string: { type: "string", description: "The exact text to replace; must appear once" },
        new_string: { type: "string", description: "The text to put in its place" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(args): Promise<ActionResult> {
      const { path, old_string: oldText, new_string: newText } = args;
      if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
        return { status: "error", error: "path, old_string, and new_string must be strings" };
      }
      if (!oldText) return { status: "error", error: "old_string must not be empty" };
      const target = await resolveMemoryFile(memoryDir, path);
      if ("error" in target) return { status: "error", error: target.error };
      const text = await readFile(target.path, "utf8").catch(() => null);
      if (text === null) return { status: "error", error: `${path} does not exist` };
      const at = text.indexOf(oldText);
      if (at < 0) return { status: "error", error: "old_string was not found" };
      if (text.indexOf(oldText, at + 1) >= 0) {
        return {
          status: "error",
          error: "old_string appears more than once; include more context",
        };
      }
      await writeFile(target.path, text.slice(0, at) + newText + text.slice(at + oldText.length));
      return { status: "ok", data: { path: target.path } };
    },
  };
}
