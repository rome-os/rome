import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { profileMemoryDir, resolveMemoryFile } from "../../lib/memory-dir.js";

export interface MemoryFileDeps {
  /** The profile's memory directory. Tests point it at a temp dir. */
  memoryDir?: string;
}

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
        content: { type: "string", description: "The file's full new content" },
      },
      required: ["path", "content"],
    },
    async execute(args): Promise<ActionResult> {
      if (typeof args.path !== "string" || typeof args.content !== "string") {
        return { status: "error", error: "path and content must be strings" };
      }
      const target = await resolveMemoryFile(memoryDir, args.path);
      if ("error" in target) return { status: "error", error: target.error };
      await mkdir(dirname(target.path), { recursive: true });
      await writeFile(target.path, args.content);
      return { status: "ok", data: { path: target.path, bytes: Buffer.byteLength(args.content) } };
    },
  };
}
