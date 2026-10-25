import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { profileMemoryDir, resolveMemoryFile } from "../../lib/memory-dir.js";
import type { MemoryFileDeps } from "../write-memory-file/index.js";

const MAX_FILES = 5_000;

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
          description:
            "Absolute path of a folder inside the memory directory. Omit for all of memory.",
        },
      },
      required: [],
    },
    async execute(args): Promise<ActionResult> {
      const folder = typeof args.path === "string" ? args.path : memoryDir;
      const target = await resolveMemoryFile(memoryDir, folder, { allowRoot: true });
      if ("error" in target) return { status: "error", error: target.error };
      const files: string[] = [];
      async function walk(dir: string): Promise<void> {
        let entries: Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (files.length >= MAX_FILES || entry.name.startsWith(".")) continue;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile()) files.push(path);
        }
      }
      await walk(target.path);
      files.sort();
      return { status: "ok", data: { count: files.length, files: files.join("\n") } };
    },
  };
}
