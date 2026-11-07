import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../types.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ArtifactOwnerType } from "../apps/types.js";
import {
  getCoreRoot,
  getCustomAppAuthoringRoot,
  getProfileDir,
  getProfileInstalledAppsDir,
  getProfileMemoryDir,
  getProjectRoot,
  getRepoAppsDir,
  getRepoDocsDir,
} from "../paths.js";
import { getInternalApiBaseUrl } from "../internal-api-url.js";
import { resolveWebchatProjectPath } from "../webchat/projects.js";
import { resolveAgentPolicy } from "../agent/index.js";

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
  /** Null when the docs did not ship, so the prompt never points at a missing path. */
  private readonly repoDocsDir: string | null;

  /**
   * @param romeEmailAddress Synchronous accessor for Rome's own provisioned
   * inbox address (`EmailSettings.address`). A getter rather than a value
   * because the address is provisioned asynchronously at boot and isn't known
   * when the builder is constructed; the address is permanently stable once
   * provisioned, and the main-agent prefix is cached lazily on the first turn
   * (after boot/provision), so reading it live at cache time is sufficient.
   *
   * @param romePublicOrigin Synchronous accessor for this instance's own public
   * web origin (`https://<slug>.<domain>`), or undefined when it has no public
   * domain (local self-hosted). A getter because a blank hosted instance
   * adopts its tenant identity at runtime, after the builder is constructed.
   */
  constructor(
    private appCatalog?: Pick<AppCatalog, "listResolved">,
    private romeEmailAddress?: () => string | undefined,
    private romePublicOrigin?: () => string | undefined,
  ) {
    this.projectRoot = getProjectRoot();
    this.coreRoot = getCoreRoot();
    this.customAppAuthoringRoot = getCustomAppAuthoringRoot();
    this.profileDir = getProfileDir();
    this.profileMemoryDir = getProfileMemoryDir();
    this.profileInstalledAppsDir = getProfileInstalledAppsDir();
    this.repoAppsDir = getRepoAppsDir(this.projectRoot);
    const repoDocsDir = getRepoDocsDir(this.projectRoot);
    this.repoDocsDir = existsSync(repoDocsDir) ? repoDocsDir : null;
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
   * Behavioral directive for clarifying questions: ask only when the answer
   * would change the direction of the work, otherwise proceed on the agent's
   * recommendation; before long-running work, state a short plan (without
   * waiting for approval) so a wrong direction is caught early; and when asking,
   * use the built-in `ask_question` tool (an interactive card) instead of prose.
   * Reinforces the tool's own description from the system prompt. Lives here
   * (rather than in a single agent's systemPromptPrefix) so every
   * @-mentionable core agent gets the same behavior.
   *
   * Gated on the agent holding the `*` action grant — the conversational agents
   * (main, assistant, coding, explore) that actually talk to the
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
      "Ask a clarifying question only when the answer would significantly change the direction of the work. Otherwise, proceed with the approach you recommend and briefly state the assumptions you made, so the guardian can redirect you.",
      "",
      "Before you start a long-running task (many steps or several minutes of work), state your plan, then start without waiting for approval, so the guardian can correct you early. Write the plan like ASD-STE100 Simplified Technical English: a few short, direct sentences, one action each, no filler. If you already show the plan as a todo list, do not repeat it in prose.",
      "",
      "When you do need to ask, use the `ask_question` tool — never write the questions in your text reply. Keep to the few questions that matter, and offer concrete options when the likely answers are enumerable.",
    ].join("\n");
  }

  private buildRuntimeContextSection(config: AgentConfig): string | null {
    if (!resolveAgentPolicy(config).loadMemory) {
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

    if (this.repoDocsDir) {
      lines.push(
        "",
        `Rome's docs are in \`${this.repoDocsDir}\`. Search them before answering whether Rome supports something.`,
      );
    }

    const publicOrigin = this.romePublicOrigin?.()?.trim();
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
    if (!resolveAgentPolicy(config).loadMemory) {
      return null;
    }

    const memory = this.readFileGracefully(join(this.profileMemoryDir, "MEMORY.md"));
    if (!memory) {
      return null;
    }

    return this.formatMarkdownSection("Memory", memory);
  }

  private buildProjectSummariesSection(config: AgentConfig): string | null {
    if (!resolveAgentPolicy(config).loadMemory) {
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

      const location = this.resolveProjectLocation(projectName);
      projectLines.push(
        location
          ? `- \`${projectName}\` (\`${location}\`): ${summary}`
          : `- \`${projectName}\`: ${summary}`,
      );
    }

    if (projectLines.length === 0) {
      return null;
    }

    return ["# Projects", "", ...projectLines].join("\n");
  }

  /**
   * Where a memory project's files live on disk. `memory/projects/<name>` only
   * mirrors `projects/<name>` best-effort (see memory/projects/README.md), and
   * app projects keep their source under the custom app authoring root, so
   * point at whichever directory actually exists — and show no path rather
   * than a made-up one.
   */
  private resolveProjectLocation(projectName: string): string | null {
    const candidates = [
      resolveWebchatProjectPath(projectName),
      join(this.customAppAuthoringRoot, projectName),
    ];
    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // Missing or unreadable — try the next candidate.
      }
    }
    return null;
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
