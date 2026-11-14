import { basename } from "node:path";
import type { ActionRegistry } from "../apps/actions/types.js";
import { AssetSourceError, AssetTooLargeError, storeAssetFromPath } from "./store.js";

// What `GET /api/assets/:name` shows inline and an `<img>` can draw.
const PICTURE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]);

function escapeMarkdownLabel(label: string): string {
  return label.replace(/[\\[\]]/g, "\\$&");
}

/**
 * Registers `core:show_file`: copies a local file into the asset store and
 * returns the Markdown that shows it in a dashboard chat.
 */
export function registerShowFileAction(actions: Pick<ActionRegistry, "register">): void {
  actions.register({
    config: {
      name: "core:show_file",
      type: "system",
      description:
        "Copy a local file into the chat and get Markdown that shows it. Use it for every picture, video or file you show in a dashboard chat. On other channels send the file with system:send_message attachments.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description:
            "Absolute local path of a file under the projects or memory folder (up to 100 MB).",
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      if (typeof args.path !== "string" || !args.path.trim()) {
        return { status: "error", error: "Path must be an absolute path" };
      }
      try {
        const stored = await storeAssetFromPath(args.path);
        const label = escapeMarkdownLabel(basename(args.path));
        const extension = stored.fileName.split(".").pop() ?? "";
        const markdown = PICTURE_EXTENSIONS.has(extension)
          ? `![${label}](${stored.url})`
          : `[${label}](${stored.url})`;
        return { status: "ok", data: { url: stored.url, markdown } };
      } catch (error) {
        if (error instanceof AssetSourceError || error instanceof AssetTooLargeError) {
          return { status: "error", error: error.message };
        }
        const reason = error instanceof Error ? error.message : String(error);
        return { status: "error", error: `Could not show the file: ${reason}` };
      }
    },
  });
}
