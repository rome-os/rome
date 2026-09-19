import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentConfig } from "../types.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ArtifactOwnerType } from "../apps/types.js";
import type { ThreadContext } from "./types.js";
import {
  getCoreRoot,
  getCustomAppAuthoringRoot,
  getProfileDir,
  getProfileInstalledAppsDir,
  getProfileMemoryDir,
  getProjectRoot,
  getRepoAppsDir,
} from "../paths.js";
import { getInternalApiBaseUrl } from "../internal-api-url.js";
import { getWebchatProjectPath, getWebchatProjectsRoot } from "../webchat/projects.js";

// Workspace context injection.
//
// A per-turn snapshot of what the user is currently seeing in the workspace
// alongside the chat (other widgets, app iframe URLs). Collected by the web
// shell at turn-send time and rendered as a `<workspace_context>` block that
// is prepended to the first user message of the turn. Not part of the cached
// system prefix, so it never invalidates `buildPrefix`.

export type WorkspaceContextBuiltin =
  | {
      kind: "projects";
      project?: string;
      files: Array<{ path: string; focused?: boolean }>;
    }
  | { kind: "desktop"; line: string };

export interface WorkspaceContextSnapshot {
  builtins: WorkspaceContextBuiltin[];
  apps: Array<{ appId: string; url: string }>;
}

/** Whole-block cap. */
export const WORKSPACE_CONTEXT_BLOCK_CHAR_LIMIT = 2000;

/** Per-project summary cap in Unicode code points, including the truncation marker. */
export const PROJECT_SUMMARY_CHAR_LIMIT = 160;

export interface PromptBuildOptions {
  /**
   * Core agents inherit Rome's platform prompt. App-owned agents start from
   * their declared systemPromptPrefix so the app author controls their base
   * instructions.
   */
  ownerType: ArtifactOwnerType;
  /** Additional caller-supplied context appended for this session. */
  contextSuffix?: string;
}

export function buildInteractiveSurfaceGuidanceSection(): string {
  return [
    "# Diagrams",
    "",
    "This chat surface renders Mermaid fenced code blocks (```mermaid) as interactive SVG diagrams. Use them to visualize architecture, workflows, state machines, and data flows when a diagram would be clearer than prose. Supported types: flowchart (graph TD/LR), sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, xychart-beta. Focus on structure (the right diagram type and clear labels) and leave styling to the host: the UI themes diagrams with Rome's own fonts and colors, so do NOT add color/font styling — no `%%{init}%%` directives, `style`/`classDef` color rules, or hard-coded fills.",
  ].join("\n");
}

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
 * crucially the project-path representation — is identical everywhere:
 *   - absolute project path = `workingDir` (the session's resolved working dir);
 *   - relative project path = `workingDir` relative to the projects root, shown
 *     only when it is a clean subpath (a real project under the root).
 *
 * Returns null when there is no thread context to show (e.g. keyless/synthetic
 * runs), in which case nothing is prepended.
 */
export function buildThreadContextBlock(
  threadContext: ThreadContext | undefined | null,
  workingDir: string | undefined,
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
    const absolutePath = workingDir?.trim();
    let sentence: string;
    if (absolutePath) {
      const relativePath = deriveProjectRelativePath(absolutePath);
      sentence =
        `Current selected project is "${xmlEscape(projectName)}" at ${xmlEscape(absolutePath)}.` +
        (relativePath ? ` Project relative path: ${xmlEscape(relativePath)}.` : "");
    } else {
      sentence = `Current selected project is "${xmlEscape(projectName)}".`;
    }
    lines.push("", sentence);
  }

  return `<thread_context>\n${lines.join("\n")}\n</thread_context>`;
}

/**
 * The project's path relative to the webchat projects root — the same value
 * webchat already shows (e.g. `default`) and that the `/projects/...` web route
 * keys off. Returns null when `workingDir` is not a clean subpath of the root
 * (e.g. a messaging channel whose working dir isn't a project), so the relative
 * line is simply omitted rather than rendering a `..`-laden path.
 */
function deriveProjectRelativePath(absolutePath: string): string | null {
  try {
    const rel = relative(getWebchatProjectsRoot(), absolutePath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel;
  } catch {
    return null;
  }
}

/**
 * PromptBuilder constructs system prompts for agents with a cache-friendly structure.
 *
 * The fixed prefix is computed once per agent and cached. Core agents receive
 * the platform prompt (agent config + CHARTER + IDENTITY + runtime context +
 * key guidance); app-owned agents receive only their declared base prompt.
 * The variable suffix (main-agent memory context, relationship data, journal
 * entries, conversation metadata, etc.) is appended fresh each turn.
 */
export class PromptBuilder {
  private prefixCache: Map<string, string> = new Map();
  private readonly customAppAuthoringRoot: string;
  private readonly projectRoot: string;
  private readonly coreRoot: string;
  private readonly profileDir: string;
  private readonly profileMemoryDir: string;
  private readonly profileInstalledAppsDir: string;
  private readonly repoAppsDir: string;

  /**
   * @param romeEmailAddress Synchronous accessor for Rome's own provisioned
   * inbox address (`EmailSettings.address`). A getter rather than a value
   * because the address is provisioned asynchronously at boot and isn't known
   * when the builder is constructed; the address is permanently stable once
   * provisioned, and the main-agent prefix is cached lazily on the first turn
   * (after boot/provision), so reading it live at cache time is sufficient.
   *
   * @param romePublicOrigin This instance's own public web origin
   * (`https://<slug>.<domain>`), or undefined when it has no public domain
   * (local self-hosted). Static from env, so a plain value rather than a getter.
   */
  constructor(
    private appCatalog?: Pick<AppCatalog, "listResolved">,
    private romeEmailAddress?: () => string | undefined,
    private romePublicOrigin?: string,
  ) {
    this.projectRoot = getProjectRoot();
    this.coreRoot = getCoreRoot();
    this.customAppAuthoringRoot = getCustomAppAuthoringRoot();
    this.profileDir = getProfileDir();
    this.profileMemoryDir = getProfileMemoryDir();
    this.profileInstalledAppsDir = getProfileInstalledAppsDir();
    this.repoAppsDir = getRepoAppsDir(this.projectRoot);
  }

  build(config: AgentConfig, options: PromptBuildOptions): string {
    const prefix = this.buildPrefix(config, options.ownerType);
    const sections = [prefix];
    const memory = options.ownerType === "core" ? this.buildMemorySection(config) : null;
    const projectSummaries =
      options.ownerType === "core" ? this.buildProjectSummariesSection(config) : null;

    if (memory) {
      sections.push(memory);
    }

    if (projectSummaries) {
      sections.push(projectSummaries);
    }

    if (options.contextSuffix) {
      sections.push(options.contextSuffix);
    }

    return sections.join("\n\n");
  }

  /**
   * Build and cache the fixed prefix for an agent.
   * This portion never changes mid-session and is cache-friendly.
   */
  buildPrefix(config: AgentConfig, ownerType: ArtifactOwnerType): string {
    const cacheKey = this.cacheKey(config.name, ownerType);
    const cached = this.prefixCache.get(cacheKey);
    if (cached) return cached;

    // An app agent's YAML is its complete base prompt. Session-level host
    // contracts (for example structured output) are attached by AgentSession,
    // but Rome's identity, policy, tools, and app catalog are core-agent
    // concerns and must not silently constrain an app author's agent.
    if (ownerType === "app") {
      const prefix = config.systemPromptPrefix.trim();
      this.prefixCache.set(cacheKey, prefix);
      return prefix;
    }

    const sections: string[] = [];

    // Agent's systemPromptPrefix from YAML config, with the ask_question
    // behavioral directive woven into the SAME block (joined by a blank line, no
    // `---` divider). It applies to every agent that can reach `ask_question`
    // (main and any @-mentionable subagent), not just main, so the behavior is
    // consistent whoever the guardian is talking to — and is gated on the action
    // actually being available so core agents without it don't get dead guidance.
    // Merged into the agent's own first-person instructions on purpose: the tool
    // description, a bottom-of-prompt mention, and a standalone top-level section
    // all proved too low-salience to reliably flip the default "ask in prose"
    // behavior; instructions in the agent's own prefix block carry more weight.
    const prefixParts: string[] = [];
    if (config.systemPromptPrefix) {
      prefixParts.push(config.systemPromptPrefix.trim());
    }
    const askQuestionGuidance = this.buildAskQuestionGuidanceSection(config);
    if (askQuestionGuidance) {
      prefixParts.push(askQuestionGuidance);
    }
    if (prefixParts.length > 0) {
      sections.push(prefixParts.join("\n\n"));
    }

    const charter = this.readFileGracefully(join(this.coreRoot, "CHARTER.md"));
    if (charter) {
      sections.push(`# Charter\n\n${charter}`);
    }

    const identity = this.readFileGracefully(join(this.profileMemoryDir, "IDENTITY.md"));
    if (identity) {
      sections.push(this.formatMarkdownSection("Identity", identity));
    }

    const runtimeContext = this.buildRuntimeContextSection(config);
    if (runtimeContext) {
      sections.push(runtimeContext);
    }

    // Platform command-line tools — shown to every core agent because these
    // executables are global runtime capabilities, not main-agent context.
    sections.push(this.buildCommandLineToolsSection());

    // Installed-app catalog — shown to every core agent (incl. subagents),
    // not just main, so they can see what's installed and reach the connector
    // catalog that lives in the connector app's description.
    const installedApps = this.buildInstalledAppsSection();
    if (installedApps) {
      sections.push(installedApps);
    }

    const prefix = sections.join("\n\n---\n\n");
    this.prefixCache.set(cacheKey, prefix);
    return prefix;
  }

  invalidate(agentName: string): void {
    this.prefixCache.delete(this.cacheKey(agentName, "core"));
    this.prefixCache.delete(this.cacheKey(agentName, "app"));
  }

  invalidateAll(): void {
    this.prefixCache.clear();
  }

  private cacheKey(agentName: string, ownerType: ArtifactOwnerType): string {
    return `${ownerType}:${agentName}`;
  }

  /**
   * Behavioral directive steering general-purpose agents toward the built-in
   * `ask_question` tool (an interactive card) instead of asking clarifying
   * questions in prose. Reinforces the tool's own description from the system
   * prompt. Lives here (rather than in a single agent's systemPromptPrefix) so
   * every @-mentionable core agent gets the same behavior.
   *
   * Gated on the agent holding the `*` action grant — the conversational agents
   * (main, assistant, planning, coding, explore) that actually talk to the
   * guardian. The tool itself is registered per-session on interactive surfaces
   * (`supportsInteractiveSurface`); the cached prefix can't see the surface, so
   * `*` is the closest stable per-agent proxy for "should reach for the card".
   */
  private buildAskQuestionGuidanceSection(config: AgentConfig): string | null {
    if (!(config.actions ?? []).includes("*")) {
      return null;
    }

    return [
      "# Asking The Guardian For Input",
      "",
      "Whenever a clarifying question blocks you — one you'd otherwise write out and wait for a reply on — you MUST ask via the `ask_question` tool, never in your text reply; listing such questions in prose (even a numbered list or inline options) is not allowed.",
      "",
      "This applies most often when a request is open-ended or underspecified and a good result depends on the guardian's preferences, constraints, or choices you do not yet know: invoke `ask_question` first to collect those answers as an interactive card, then continue once the guardian replies — do not guess a generic result. Ask only the few questions that actually change what you do next, and prefer single-choice questions with concrete options when the likely answers are enumerable.",
    ].join("\n");
  }

  private buildRuntimeContextSection(config: AgentConfig): string | null {
    if (config.name !== "main") {
      return null;
    }

    const internalApiBaseUrl = getInternalApiBaseUrl();
    const lines = [
      "# Runtime Context",
      "",
      `- Active profile directory: \`${this.profileDir}\``,
      `- Profile memory directory: \`${this.profileMemoryDir}\``,
      `- Custom app authoring directory: \`${this.customAppAuthoringRoot}\``,
      `- Installed apps directory: \`${this.profileInstalledAppsDir}\``,
      `- Repo seed apps directory: \`${this.repoAppsDir}\``,
      "",
      "Installable app model:",
      "- Load runtime apps from the active profile's installed apps directory or custom app authoring directory.",
      "- Use the active custom app authoring directory for custom app source, builds, tests, and DB work during local development.",
      "- Custom apps use `~/.rome/<profile>/projects/apps/<appId>/` as both the local authoring root and the runtime source of truth by default.",
      "- Repo-local `rome_apps/` remains the seed source for platform-shipped apps, including bootstrap and repair flows for `system`.",
      "- Do not treat repo-local `rome_apps/` as the live runtime root for custom apps.",
      "- Installable apps can contribute agents, actions, skills, hooks, web bundles, API entrypoints, and DB migrations.",
      "- In Rome product context, 'store', 'app store', or 'marketplace' usually means the Rome App Store unless the guardian clearly means an external store like Apple App Store or Google Play.",
      "",
      "Agent browser:",
      "- The platform runs a persistent browser that you operate to do work on the web — researching, filling forms, placing orders, and reading or acting inside the guardian's own accounts on other services (e.g. UberEats, DoorDash, Amazon, banking). The guardian can watch what you do in real time on the [Browser](/desktop) page.",
      "- The browser profile is persistent: a site the guardian signs into once stays logged in for later turns, so you can reuse an authenticated session without signing in again. If the guardian asks you to perform a task behind an auth wall while the account is not logged in, ask the guardian if they would like to log in using the browser.",
      `- In the agent browser, visit \`${internalApiBaseUrl}\` to open the Rome dashboard, or \`${internalApiBaseUrl}/apps/<appId>\` to use a specific app.`,
    ];

    const publicOrigin = this.romePublicOrigin?.trim();
    if (publicOrigin) {
      lines.push(
        "",
        `Your public web address is \`${publicOrigin}\`\. It's the address to share with the guardian or hand to external services (e.g. OAuth redirects, links you send out).`,
      );
    }

    const emailAddress = this.romeEmailAddress?.()?.trim();
    if (emailAddress) {
      lines.push(
        "",
        `Your email address: \`${emailAddress}\`. `,
        `You may use this email address to sign up for any newsletters, waitlists, services, or accounts needed to complete the task. You may receive and use verification emails, links, or codes for those signups.`,
      );
    }

    return lines.join("\n");
  }

  private buildCommandLineToolsSection(): string {
    return [
      "# Command Line Tools",
      "",
      "- A global `discord` CLI is available to access Discord through Rome's connected bot. When a task requires current information from this connected Discord environment—such as channel history, messages, channels, threads, members, roles, or guild configuration—or a requested Discord management operation, prefer `discord api` over memory because it is live and authoritative. Run `discord api --help` when needed.",
      '- Run `rome-node help` to learn the remote computer CLI and `rome-node help device run` for action arguments and result handling. Use `rome-node device` to list authorized remote computers. Authorization does not mean online. Use `rome-node device describe <id>` to query its platform and supported actions. Execute a program with `rome-node device run <id> exec --args \'{"command":"git","args":["status"],"cwd":"/workspace"}\'`. On macOS/Linux, read files with cat and list directories with ls. On Windows, explicitly invoke powershell.exe with Get-Content, Set-Content, or Get-ChildItem. Use an explicit shell for redirection or pipelines. Check exitCode, stderr, and truncated output. Never automatically retry an unknown outcome: a local timeout does not cancel the remote process. Never read or print device credential files.',
    ].join("\n");
  }

  /**
   * The installed-app catalog (app id + manifest description), surfaced to
   * every core agent — not just main. Core subagents act on the guardian's
   * behalf too, so they need to know what apps exist and what each does. It also carries the
   * connector catalog: the `connector` app's description lists the connectable
   * toolkits and their `connector_proxy` API hosts, so an agent that can't see
   * this section can't pick connectors. Returns null when nothing is installed.
   */
  private buildInstalledAppsSection(): string | null {
    const apps = this.appCatalog?.listResolved() ?? [];
    if (apps.length === 0) {
      return null;
    }

    const lines = ["# Installed Apps", ""];
    for (const app of apps) {
      lines.push(`- \`${app.appId}\`: ${app.manifest.description}`);
    }
    return lines.join("\n");
  }

  private buildMemorySection(config: AgentConfig): string | null {
    if (config.name !== "main") {
      return null;
    }

    const memory = this.readFileGracefully(join(this.profileMemoryDir, "MEMORY.md"));
    if (!memory) {
      return null;
    }

    return this.formatMarkdownSection("Memory", memory);
  }

  private buildProjectSummariesSection(config: AgentConfig): string | null {
    if (config.name !== "main") {
      return null;
    }

    const projectsDir = join(this.profileMemoryDir, "projects");
    let entries: string[] = [];

    try {
      entries = readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return null;
    }

    const projectLines: string[] = [];
    for (const projectName of entries) {
      const projectFilePath = join(projectsDir, projectName, "PROJECT.md");
      const summary = this.readFirstParagraph(projectFilePath);
      if (!summary) {
        continue;
      }

      projectLines.push(
        `- \`${projectName}\` (\`${getWebchatProjectPath(projectName)}\`): ${summary}`,
      );
    }

    if (projectLines.length === 0) {
      return null;
    }

    return ["# Projects", "", ...projectLines].join("\n");
  }

  private readFirstParagraph(filePath: string): string | null {
    const content = this.readFileGracefully(filePath);
    if (!content) {
      return null;
    }

    const blocks = content
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean);

    for (const block of blocks) {
      const lines = block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length === 0) {
        continue;
      }

      const paragraphLines = lines.filter((line) => !line.startsWith("#"));
      if (paragraphLines.length === 0) {
        continue;
      }

      const summary = paragraphLines.join(" ");
      const characters = Array.from(summary);
      if (characters.length > PROJECT_SUMMARY_CHAR_LIMIT) {
        return `${characters
          .slice(0, PROJECT_SUMMARY_CHAR_LIMIT - 1)
          .join("")
          .trimEnd()}…`;
      }
      return summary;
    }

    return null;
  }

  private formatMarkdownSection(title: string, content: string): string {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingPattern = new RegExp(`^#\\s+${escapedTitle}(?:\\s|$)`, "i");
    if (headingPattern.test(content)) {
      return content;
    }

    return `# ${title}\n\n${content}`;
  }

  private readFileGracefully(filePath: string): string | null {
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      return content || null;
    } catch {
      return null;
    }
  }
}
