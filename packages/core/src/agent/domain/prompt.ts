// What Rome adds to a prompt about where the turn stands. Agent model:
// docs/domains/agents.md#prompt.

import type { ThreadContext } from "@rome-os/app-runtime";

export type WorkspaceContextBuiltin =
  | {
      kind: "projects";
      project?: string;
      files: Array<{ path: string; focused?: boolean }>;
    }
  | { kind: "desktop"; line: string };

/**
 * A per-turn snapshot of what the user is currently seeing in the workspace
 * alongside the chat (other widgets, app iframe URLs). The web shell collects
 * it when the turn is sent.
 */
export interface WorkspaceContextSnapshot {
  builtins: WorkspaceContextBuiltin[];
  apps: Array<{ appId: string; url: string }>;
}

/** Whole-block cap. */
export const WORKSPACE_CONTEXT_BLOCK_CHAR_LIMIT = 2000;

/**
 * Escape `<`, `>`, and `&` in user-controlled strings before interpolating
 * them into the `<workspace_context>` (or `<thread_context>`) block. Without
 * this, a file path, a desktop status line, or an app URL containing
 * `</workspace_context>` would close the block early — and any text after it
 * would be read by the model as a fresh user instruction rather than as
 * workspace metadata. App URLs are the load-bearing case: the iframe contents
 * are controlled by the third-party app and can be navigated to any value at
 * any time.
 */
function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** {@link xmlEscape} for a value inside a double-quoted attribute. */
export function xmlAttr(value: string): string {
  return xmlEscape(value).replace(/"/g, "&quot;");
}

/**
 * Render a workspace-context snapshot into a `<workspace_context>` XML block
 * suitable for prepending to a user message. Returns null when the snapshot
 * is empty or malformed.
 */
export function buildWorkspaceContextSection(
  snapshot: WorkspaceContextSnapshot | undefined | null,
): string | null {
  if (!snapshot) return null;
  const lines: string[] = [];
  const builtins = Array.isArray(snapshot.builtins) ? snapshot.builtins : [];
  const apps = Array.isArray(snapshot.apps) ? snapshot.apps : [];
  if (builtins.length === 0 && apps.length === 0) return null;

  lines.push(
    "The user currently has these surfaces open in their workspace alongside this chat:",
    "",
  );

  let hasAppEntry = false;

  for (const builtin of builtins) {
    if (!builtin || typeof builtin !== "object") continue;
    if (builtin.kind === "projects") {
      // Project name is optional — it can be absent on the very first turn
      // before a session exists. Render `- projects` alone in that case
      // rather than a placeholder; the file lines below carry the signal
      // the agent actually needs.
      const project =
        typeof builtin.project === "string" && builtin.project ? builtin.project : null;
      lines.push(project ? `- projects: ${xmlEscape(project)}` : `- projects`);
      const files = Array.isArray(builtin.files) ? builtin.files : [];
      for (const file of files) {
        if (!file || typeof file !== "object" || typeof file.path !== "string") continue;
        const marker = file.focused ? " (focused)" : "";
        lines.push(`    - ${xmlEscape(file.path)}${marker}`);
      }
    } else if (builtin.kind === "desktop") {
      const line = typeof builtin.line === "string" && builtin.line ? builtin.line : "(active)";
      lines.push(`- desktop: ${xmlEscape(line)}`);
    }
  }

  for (const app of apps) {
    if (!app || typeof app !== "object") continue;
    if (typeof app.appId !== "string" || typeof app.url !== "string") continue;
    if (!app.appId || !app.url) continue;
    hasAppEntry = true;
    lines.push(`- app: ${xmlEscape(app.appId)} — ${xmlEscape(app.url)}`);
  }

  if (hasAppEntry) {
    lines.push(
      "",
      "For installed apps, you can use a browser action to open the URL if you need to see what the user is looking at.",
    );
  }

  // Truncate from the bottom and append a marker so the agent knows entries were dropped.
  let body = lines.join("\n");
  if (body.length > WORKSPACE_CONTEXT_BLOCK_CHAR_LIMIT) {
    const marker = "\n… (truncated)";
    body = body.slice(0, WORKSPACE_CONTEXT_BLOCK_CHAR_LIMIT - marker.length) + marker;
  }

  return `<workspace_context>\n${body}\n</workspace_context>`;
}

/**
 * Render the conversation's thread + project framing as a `<thread_context>`
 * XML block, prepended to the SESSION'S FIRST user message (see AgentSession).
 *
 * This is the per-thread, dynamic counterpart to the stable Guardian profile:
 * keeping it on the first user message (rather than appending it to the system
 * prompt) leaves the cached system prefix identical across every session, the
 * same reasoning as `buildWorkspaceContextSection` above.
 *
 * One renderer feeds every channel (webchat + Telegram/WhatsApp/Discord) off
 * the structured `ThreadContext` the session already holds, so the block — and
 * crucially the project-path representation — is identical everywhere. The
 * relative path shows only when the project sits under the projects root.
 *
 * Returns null when there is no thread context to show (e.g. keyless/synthetic
 * runs), in which case nothing is prepended.
 */
export function buildThreadContextBlock(
  threadContext: ThreadContext | undefined | null,
  project: { path: string | undefined; relativePath: string | null },
): string | null {
  if (!threadContext) return null;

  const lines: string[] = [
    `channel: ${xmlEscape(threadContext.channel)}`,
    `thread type: ${xmlEscape(threadContext.threadType ?? "unknown")}`,
    `thread id: ${xmlEscape(threadContext.threadId)}`,
  ];

  if (threadContext.channelUserId?.trim()) {
    lines.push(`channelUserId: ${xmlEscape(threadContext.channelUserId.trim())}`);
  }
  if (threadContext.threadName?.trim()) {
    lines.push(`thread name: ${xmlEscape(threadContext.threadName.trim())}`);
  }

  lines.push(
    `is direct message: ${threadContext.threadType === "private" ? "yes" : "no"}`,
    `is group chat: ${threadContext.threadType === "group" ? "yes" : "no"}`,
  );

  const projectName = threadContext.projectName?.trim();
  if (projectName) {
    let sentence: string;
    if (project.path) {
      sentence =
        `Current selected project is "${xmlEscape(projectName)}" at ${xmlEscape(project.path)}.` +
        (project.relativePath ? ` Project relative path: ${xmlEscape(project.relativePath)}.` : "");
    } else {
      sentence = `Current selected project is "${xmlEscape(projectName)}".`;
    }
    lines.push("", sentence);
  }

  return `<thread_context>\n${lines.join("\n")}\n</thread_context>`;
}

export const FETCH_CHANNEL_HISTORY_ACTION = "system:fetch_channel_history";

/**
 * Render a `<continuation>` block for the first turn of a model thread that
 * replaced the one holding the chat, after a move to another provider. Rome's
 * transcript still has every message; the agent reads what it needs. It names
 * no channel: the thread's channel and id are in its thread context.
 */
export function buildContinuationBlock(input: {
  /** The model the chat ran on before this thread. */
  previousModel?: string;
  /** The agent may call `system:fetch_channel_history`. */
  canReadHistory: boolean;
  /** What a renewal's handoff adds, from `handoffSections`, one string per line. */
  handoff?: readonly string[];
}): string {
  const open = input.previousModel
    ? `<continuation previous_model="${xmlAttr(input.previousModel)}">`
    : "<continuation>";
  const lines = [
    "This conversation started before your current context, so its earlier messages are not in your context.",
  ];
  if (input.canReadHistory) {
    lines.push(
      `When the conversation needs them, read them with \`${FETCH_CHANNEL_HISTORY_ACTION}\`, passing this thread's channel and thread id. To page back, pass limit, then the nextCursor it returns as cursor.`,
    );
  }
  if (input.handoff) lines.push(...input.handoff);
  return `${open}\n${lines.join("\n")}\n</continuation>`;
}

/**
 * Render the chat's device folder as a `<device_folder>` block. Unlike
 * `<thread_context>`, AgentSession prepends it to EVERY user message, so the
 * agent still knows where to work after context compaction drops the first
 * message. Returns null when the chat has no device folder.
 */
export function buildDeviceFolderBlock(
  threadContext: ThreadContext | undefined | null,
): string | null {
  const folder = threadContext?.deviceFolder;
  if (!folder) return null;
  const device = [folder.deviceId, folder.platform].filter(Boolean).join(", ");
  return [
    "<device_folder>",
    `Work in folder "${xmlEscape(folder.path)}" on Rome node device "${xmlEscape(folder.deviceName)}" (id ${xmlEscape(device)}).` +
      " Your local working directory is NOT this folder.",
    `Run programs there with \`rome-node device run ${xmlEscape(folder.deviceId)} exec\` and cwd set to that folder.`,
    "</device_folder>",
  ].join("\n");
}

/** The header blocks an input opens with, by name, as {@link withoutRepeatedHeaders} last kept them. */
export type SentHeaders = ReadonlyMap<string, string>;

/**
 * `prompt` without the header blocks it opens with that equal the ones the
 * thread already read: a block named in `names` that starts the prompt,
 * either one self-closing tag on its own line (`<concierge_chat … />`) or an
 * element to its closing tag (`<workspace_context>…</workspace_context>`).
 * Only the run of such blocks at the very start counts. Returns the prompt and
 * the headers the thread will have read once it reads it.
 */
export function withoutRepeatedHeaders(
  prompt: string,
  names: readonly string[],
  sent: SentHeaders,
): { prompt: string; headers: Map<string, string> } {
  const headers = new Map(sent);
  const kept: string[] = [];
  let rest = prompt;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    const name = names.find((candidate) => trimmed.startsWith(`<${candidate}`));
    const after = name ? trimmed.charAt(name.length + 1) : "";
    if (!name || !(after === " " || after === ">" || after === "/")) break;
    const lineEnd = trimmed.indexOf("\n");
    const firstLine = lineEnd === -1 ? trimmed : trimmed.slice(0, lineEnd);
    let end: number;
    if (firstLine.trimEnd().endsWith("/>")) {
      end = firstLine.length;
    } else {
      const close = trimmed.indexOf(`</${name}>`);
      if (close === -1) break;
      end = close + name.length + 3;
    }
    const block = trimmed.slice(0, end);
    if (sent.get(name) !== block) kept.push(block);
    headers.set(name, block);
    rest = trimmed.slice(end);
  }
  if (rest === prompt) return { prompt, headers };
  const body = rest.replace(/^\s+/, "");
  return { prompt: kept.length > 0 ? `${kept.join("\n")}\n\n${body}` : body, headers };
}
