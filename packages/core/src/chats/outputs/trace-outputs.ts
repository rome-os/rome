import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { ChatOutputKind } from "@rome/api-types/chat-outputs";
import { describeFile } from "../../lib/file-browser-server.js";
import { shellWrites } from "./shell-writes.js";

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

/**
 * What reading a shell command's or a reply's files needs: their text names
 * a file loosely, so only a file that is there now, in a folder the agent
 * produces in, counts. A log in a temporary folder or the owner's attachment
 * in the asset store is not one.
 */
export interface OutputScope {
  /** Where `/projects/<path>` links point. */
  projectsRoot: string;
  /** The folders a loosely named file must be in: the projects and memory folders. */
  roots: readonly string[];
  /** When regular file `path` was last changed, in milliseconds; null when it is not one. */
  changedAt: (path: string) => number | null;
}

/** Where a stretch of trace comes from, and what reading its loosely named files needs. */
export interface TraceContext {
  /** The trace's message: every record key carries it, as a tool call's id is only unique within its turn. */
  traceId: string;
  /** A call an earlier stretch of the trace stored. */
  findUse?: (toolUseId: string) => ToolUseBlock | null;
  /** Without it, shell commands and replies are not read. */
  files?: OutputScope;
  /**
   * When the turn began. A file the reply links counts only when it changed
   * since, so a file the agent only cites is not one it produced.
   */
  startedAt?: Date;
}

// How much earlier than the turn's start a file's change time may read, for a
// file system that keeps it coarsely.
const CHANGE_TIME_SLACK_MS = 2000;

/**
 * Whether `path`, named loosely, is a file the agent could have produced: a
 * file in one of the scope's folders, changed since `since` when one is given.
 */
function producible(path: string, scope: OutputScope, since?: Date): boolean {
  const inRoot = scope.roots.some((root) => {
    const base = resolve(root);
    return path === base || path.startsWith(base + sep);
  });
  if (!inRoot) return false;
  const changedAt = scope.changedAt(path);
  if (changedAt === null) return false;
  return !since || changedAt >= since.getTime() - CHANGE_TIME_SLACK_MS;
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
// Tools that run a shell command: Claude Code's, and Codex's command run,
// which the trace names `Bash` too.
const SHELL_TOOLS = new Set(["Bash"]);
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

/**
 * The files a shell tool call's command plainly writes, absolute: a relative
 * one resolved against the command's folder. One whose folder the call does
 * not give is left out, as there is no telling where it went.
 */
export function shellWrittenPaths(tool: string | undefined, input: unknown): string[] {
  if (!tool || !SHELL_TOOLS.has(tool)) return [];
  const args = record(input);
  const command = args?.command;
  if (typeof command !== "string") return [];
  const cwd = typeof args?.cwd === "string" && isAbsolute(args.cwd) ? args.cwd : null;
  return shellWrites(command).flatMap((path) =>
    isAbsolute(path) ? [resolve(path)] : cwd ? [resolve(cwd, path)] : [],
  );
}

/** Whether a shell result says its command finished without failing. */
function shellSucceeded(result: ToolResultBlock): boolean {
  if (result.isError === true) return false;
  const output = record(result.output);
  if (!output) return true;
  const exitCode = output.exitCode;
  return (
    (exitCode === undefined || exitCode === null || exitCode === 0) && output.status !== "failed"
  );
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
export function outputsOfToolCall(
  use: ToolUseBlock,
  result: ToolResultBlock,
  { traceId, files }: Pick<TraceContext, "traceId" | "files">,
): OutputFound[] {
  if (result.isError === true || !use.id) return [];
  const key = `${traceId}:${use.id}`;
  const fromShell = shellWrittenPaths(use.tool, use.input);
  if (fromShell.length > 0) {
    if (!files || !shellSucceeded(result)) return [];
    return fromShell
      .filter((path) => producible(path, files))
      .map((path) => writtenFile(`${key}#sh:${path}`, path));
  }
  const written = writtenPaths(use.tool, use.input);
  if (written.length > 0) {
    return written.map((path, index) =>
      writtenFile(written.length === 1 ? key : `${key}#${index}`, path),
    );
  }
  const shownFrom = showFilePath(use.tool, use.input);
  if (shownFrom === undefined) return [];
  const url = ASSET_URL.exec(text(result.output))?.[0];
  if (!url) return [];
  const name = shownFrom ? basename(shownFrom) : basename(url);
  return [
    {
      sourceKey: key,
      kind: "shown",
      path: url,
      sourcePath: shownFrom,
      name,
      mimeType: outputMimeType(url),
    },
  ];
}

/**
 * The outputs among `blocks`, a stretch of trace `context.traceId`. A
 * result's call is looked up in `blocks` first, then with `findUse`, for a
 * call an earlier stretch recorded.
 */
export function outputsInTrace(blocks: readonly unknown[], context: TraceContext): OutputFound[] {
  const { traceId, findUse = () => null, files, startedAt } = context;
  const uses = new Map<string, ToolUseBlock>();
  const found: OutputFound[] = [];
  for (const raw of blocks) {
    const block = record(raw);
    if (!block) continue;
    if (block.type === "tool_use" && typeof block.id === "string") {
      uses.set(block.id, block as unknown as ToolUseBlock);
      continue;
    }
    // A turn's reply: the local files it links.
    if (block.type === "result" && files && typeof block.content === "string") {
      found.push(...outputsInReply(traceId, block.content, files, startedAt));
      continue;
    }
    if (block.type !== "tool_result" || typeof block.toolUseId !== "string") continue;
    const result = block as unknown as ToolResultBlock;
    // Only a result whose tool could have written or shown a file looks its
    // call up. An action's result shows a file only when it holds a copy's URL.
    if (result.tool && !mayWrite(result.tool)) continue;
    if (result.tool === ACTION_TOOL && !ASSET_URL.test(text(result.output))) continue;
    const use = uses.get(block.toolUseId) ?? findUse(block.toolUseId);
    if (use) found.push(...outputsOfToolCall(use, result, { traceId, files }));
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
  return (
    writtenPaths(tool, use.input).length > 0 ||
    shellWrittenPaths(tool, use.input).length > 0 ||
    showFilePath(tool, use.input) !== undefined
  );
}

/** Whether a tool's result could hold an output: a write, a shell command or an action. */
function mayWrite(tool: string): boolean {
  return WRITE_TOOLS.has(tool) || SHELL_TOOLS.has(tool) || tool === ACTION_TOOL;
}

/** Whether a trace stretch has a result that might have made an output. */
export function mayHoldOutputs(blocks: readonly unknown[]): boolean {
  return blocks.some((raw) => {
    const block = record(raw);
    if (block?.type === "result") return true;
    return (
      block?.type === "tool_result" &&
      block.isError !== true &&
      (typeof block.tool !== "string" || mayWrite(block.tool))
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

/**
 * The local files a turn's reply links, by Markdown link: a `/projects/<path>`
 * route or an absolute path, each kept only while it is a file in the
 * projects or memory folder that changed since the turn began (`startedAt`):
 * a file the reply only cites is not one. An asset, a web page or a relative
 * link is not one of them.
 */
export function outputsInReply(
  traceId: string,
  reply: string,
  scope: OutputScope,
  startedAt?: Date,
): OutputFound[] {
  const found = new Map<string, OutputFound>();
  for (const match of reply.matchAll(MARKDOWN_LINK)) {
    const path = localPath(match[2] ?? match[3], scope.projectsRoot);
    if (path && !found.has(path) && producible(path, scope, startedAt)) {
      found.set(path, writtenFile(`reply:${traceId}:${path}`, path));
    }
  }
  return [...found.values()];
}

/**
 * A Markdown link: `[label](href)`, `[label](<href>)`, or `[label](href with
 * spaces)` as an agent writes it against the rule, with an optional `"…"`,
 * `'…'` or `(…)` title, an image's `![label](href)` too. A bare href may hold
 * balanced parentheses. Groups: the label with its brackets, the bracketed
 * href, the bare href, the title.
 */
const MARKDOWN_LINK = new RegExp(
  // The label, then `(` and any blanks.
  String.raw`(!?\[(?:\\.|[^\]\\])*\])\([ \t]*` +
    // A bracketed href, or a bare one that starts and ends with a non-blank,
    // so no run of blanks can be split between its parts.
    String.raw`(?:<([^>\n]+)>|((?:[^()\s]|\([^()\n]*\))(?:(?:[^()\n]|\([^()\n]*\))*?(?:[^()\s]|\([^()\n]*\)))?))` +
    String.raw`([ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)`,
  "g",
);

/** The file a link's `href` points at on this machine, or null for anything else. */
function localPath(href: string, projectsRoot: string): string | null {
  let path = href.trim().replace(/[?#].*$/, "");
  try {
    path = decodeURI(path);
  } catch {
    return null;
  }
  if (path.startsWith("file://")) path = path.slice("file://".length);
  if (path.startsWith("/projects/")) {
    const rel = path.slice("/projects/".length);
    const root = resolve(projectsRoot);
    const file = resolve(join(root, rel));
    return file.startsWith(root + sep) ? file : null;
  }
  if (!isAbsolute(path) || path.startsWith("/api/")) return null;
  return resolve(path);
}

function writtenFile(sourceKey: string, path: string): OutputFound {
  return {
    sourceKey,
    kind: "written",
    path,
    sourcePath: null,
    name: basename(path),
    mimeType: outputMimeType(path),
  };
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
