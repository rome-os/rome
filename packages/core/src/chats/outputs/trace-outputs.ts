import { basename } from "node:path";
import type { ChatOutputKind } from "@rome/api-types/chat-outputs";
import { describeFile } from "../../lib/file-browser-server.js";

/** An output found in a trace or a message, before it is stored. */
export interface OutputFound {
  sourceKey: string;
  kind: ChatOutputKind;
  path: string;
  sourcePath: string | null;
  name: string;
  mimeType: string | null;
}

/** The trace blocks this module reads. Others pass through untouched. */
export interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  tool?: string;
  input?: unknown;
}

interface ToolResultBlock {
  type: "tool_result";
  toolUseId?: string;
  tool?: string;
  output?: unknown;
  isError?: boolean;
}

// Tools that write a file: Claude Code's, and Codex's file change, which the
// trace names `Edit`.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const ACTION_TOOL = "execute_action";
const SHOW_FILE_ACTIONS = new Set(["core:show_file", "show_file"]);

// `/api/assets/<id>.<ext>`, as the asset store names a copy.
const ASSET_URL = /\/api\/assets\/[0-9a-f]{32}\.[a-z0-9]{1,8}/;
const ASSET_URL_GLOBAL = new RegExp(ASSET_URL.source, "g");

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The type the extension names, or null when it names none. */
export function outputMimeType(name: string): string | null {
  const { mimeType } = describeFile(name);
  return mimeType === "application/octet-stream" ? null : mimeType.split(";")[0].trim();
}

/** The files a write tool call names: one for Claude Code's tools, each change for Codex's. */
export function writtenPaths(tool: string | undefined, input: unknown): string[] {
  if (!tool || !WRITE_TOOLS.has(tool)) return [];
  const args = record(input);
  if (!args) return [];
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return [value.trim()];
  }
  if (!Array.isArray(args.changes)) return [];
  return args.changes.flatMap((change) => {
    const path = record(change)?.path;
    return typeof path === "string" && path.trim() ? [path.trim()] : [];
  });
}

/** The local path a `core:show_file` call names, or null for any other call. */
function showFilePath(tool: string | undefined, input: unknown): string | null | undefined {
  if (tool !== ACTION_TOOL) return undefined;
  const args = record(input);
  const action = args?.action_name ?? args?.name;
  if (typeof action !== "string" || !SHOW_FILE_ACTIONS.has(action)) return undefined;
  const path = record(args?.json_args ?? args?.input)?.path;
  return typeof path === "string" && path.trim() ? path.trim() : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * The outputs one finished tool call made: the files a write tool wrote, or
 * the copy `core:show_file` stored. A failed call made none. A Codex change
 * that touched several files made one output each.
 */
export function outputsOfToolCall(use: ToolUseBlock, result: ToolResultBlock): OutputFound[] {
  if (result.isError === true || !use.id) return [];
  const written = writtenPaths(use.tool, use.input);
  if (written.length > 0) {
    return written.map((path, index) => ({
      sourceKey: written.length === 1 ? use.id! : `${use.id}#${index}`,
      kind: "written",
      path,
      sourcePath: null,
      name: basename(path),
      mimeType: outputMimeType(path),
    }));
  }
  const shownFrom = showFilePath(use.tool, use.input);
  if (shownFrom === undefined) return [];
  const url = ASSET_URL.exec(text(result.output))?.[0];
  if (!url) return [];
  const name = shownFrom ? basename(shownFrom) : basename(url);
  return [
    {
      sourceKey: use.id,
      kind: "shown",
      path: url,
      sourcePath: shownFrom,
      name,
      mimeType: outputMimeType(url),
    },
  ];
}

/**
 * The outputs among `blocks`, a stretch of one trace. A result's call is
 * looked up in `blocks` first, then with `findUse`, for a call an earlier
 * stretch recorded.
 */
export function outputsInTrace(
  blocks: readonly unknown[],
  findUse: (toolUseId: string) => ToolUseBlock | null = () => null,
): OutputFound[] {
  const uses = new Map<string, ToolUseBlock>();
  const found: OutputFound[] = [];
  for (const raw of blocks) {
    const block = record(raw);
    if (!block) continue;
    if (block.type === "tool_use" && typeof block.id === "string") {
      uses.set(block.id, block as unknown as ToolUseBlock);
      continue;
    }
    if (block.type !== "tool_result" || typeof block.toolUseId !== "string") continue;
    const result = block as unknown as ToolResultBlock;
    // Only a result whose tool could have written or shown a file looks its
    // call up. An action's result shows a file only when it holds a copy's URL.
    if (result.tool && !WRITE_TOOLS.has(result.tool) && result.tool !== ACTION_TOOL) continue;
    if (result.tool === ACTION_TOOL && !ASSET_URL.test(text(result.output))) continue;
    const use = uses.get(block.toolUseId) ?? findUse(block.toolUseId);
    if (use) found.push(...outputsOfToolCall(use, result));
  }
  return found;
}

/**
 * Whether trace block `block` is a call that can make an output: a write
 * tool's, or `core:show_file`'s. Only these are worth remembering until their
 * result arrives.
 */
export function isOutputCall(block: unknown): block is ToolUseBlock & { id: string } {
  const use = record(block);
  if (use?.type !== "tool_use" || typeof use.id !== "string") return false;
  const tool = typeof use.tool === "string" ? use.tool : undefined;
  return writtenPaths(tool, use.input).length > 0 || showFilePath(tool, use.input) !== undefined;
}

/** Whether a trace stretch has a result that might have made an output. */
export function mayHoldOutputs(blocks: readonly unknown[]): boolean {
  return blocks.some((raw) => {
    const block = record(raw);
    return (
      block?.type === "tool_result" &&
      block.isError !== true &&
      (typeof block.tool !== "string" || WRITE_TOOLS.has(block.tool) || block.tool === ACTION_TOOL)
    );
  });
}

/**
 * The shown files an agent message links: every asset URL in it, named by its
 * link text when it has one. A message from before outputs were recorded is
 * read this way, as the only trace of what it showed.
 */
export function outputsInMessage(messageId: string, content: string): OutputFound[] {
  const found = new Map<string, OutputFound>();
  const markdown = messageText(content);
  // Markdown `[label](url)` or `![label](url)`.
  const labelled = /!?\[((?:\\.|[^\]\\])*)\]\((\/api\/assets\/[0-9a-f]{32}\.[a-z0-9]{1,8})\)/g;
  for (const match of markdown.matchAll(labelled)) {
    const url = match[2];
    const label = match[1].replace(/\\(.)/g, "$1").trim();
    if (!found.has(url)) found.set(url, shownLink(messageId, url, label));
  }
  for (const match of markdown.matchAll(ASSET_URL_GLOBAL)) {
    const url = match[0];
    if (!found.has(url)) found.set(url, shownLink(messageId, url, ""));
  }
  return [...found.values()];
}

/** Every asset URL a message holds anywhere: what a guardian's message attached. */
export function assetUrlsIn(content: string): string[] {
  return [...messageText(content).matchAll(ASSET_URL_GLOBAL)].map((match) => match[0]);
}

/** Every string in a stored message's JSON parts, one per line; the text itself when it is not JSON. */
function messageText(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  const strings: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(parsed);
  return strings.join("\n");
}

function shownLink(messageId: string, url: string, label: string): OutputFound {
  // A label that looks like a file name names the file; anything else is prose.
  const name = /\.[A-Za-z0-9]{1,8}$/.test(label) && !label.includes("/") ? label : basename(url);
  return {
    sourceKey: `link:${messageId}:${url}`,
    kind: "shown",
    path: url,
    sourcePath: null,
    name,
    mimeType: outputMimeType(url),
  };
}
