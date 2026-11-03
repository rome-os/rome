import { readFile } from "node:fs/promises";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { profileMemoryDir, resolveMemoryFile } from "../../lib/memory-dir.js";
import type { MemoryFileDeps } from "../write-memory-file/index.js";

/** Memory files are short notes; a larger one is returned cut. */
const MAX_CHARS = 200_000;

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
      },
      required: ["path"],
    },
    async execute(args): Promise<ActionResult> {
      if (typeof args.path !== "string") return { status: "error", error: "path must be a string" };
      const target = await resolveMemoryFile(memoryDir, args.path);
      if ("error" in target) return { status: "error", error: target.error };
      const text = await readFile(target.path, "utf8").catch(() => null);
      if (text === null) return { status: "error", error: "The file does not exist" };
      return {
        status: "ok",
        data: {
          path: target.path,
          content: text.slice(0, MAX_CHARS),
          truncated: text.length > MAX_CHARS,
        },
      };
    },
  };
}
