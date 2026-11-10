// What the model reads before the conversation. Agent model:
// docs/domains/agents.md#system-prompt.

import { resolveAgentPolicy, type AgentPolicy } from "./agent-policy.js";
import type { AgentName } from "./session.js";
import type { WidgetDrawing } from "./widget-drawing.js";

/** Per-project summary cap in Unicode code points, including the truncation marker. */
export const PROJECT_SUMMARY_CHAR_LIMIT = 160;

const SECTION_DIVIDER = "\n\n---\n\n";

const DIAGRAMS_SECTION = [
  "# Diagrams",
  "",
  "This chat surface renders Mermaid fenced code blocks (```mermaid) as interactive SVG diagrams. Use them to visualize architecture, workflows, state machines, and data flows when a diagram would be clearer than prose. Supported types: flowchart (graph TD/LR), sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, xychart-beta. Focus on structure (the right diagram type and clear labels) and leave styling to the host: the UI themes diagrams with Rome's own fonts and colors, so do NOT add color/font styling — no `%%{init}%%` directives, `style`/`classDef` color rules, or hard-coded fills.",
].join("\n");

/** What a system prompt reads of an agent. */
export interface PromptAgent {
  name: AgentName;
  /**
   * Core agents inherit Rome's platform prompt. App-owned agents start from
   * their declared prompt so the app author controls their base instructions.
   */
  owner: "core" | "app";
  systemPromptPrefix: string;
  actions?: readonly string[];
  policy?: Partial<AgentPolicy>;
}

/** Value object. What Rome tells a core agent about where it runs. */
export interface RuntimeFacts {
  profileDir: string;
  profileMemoryDir: string;
  customAppAuthoringDir: string;
  installedAppsDir: string;
  repoAppsDir: string;
  internalApiBaseUrl: string;
  /** Null when the docs did not ship, so the prompt never names a missing path. */
  docsDir: string | null;
  publicOrigin?: string;
  emailAddress?: string;
}

/** Value object. What a core agent's fixed part quotes from outside the agent. */
export interface PromptMaterial {
  charter: string | null;
  identity: string | null;
  runtime: RuntimeFacts;
  installedApps: readonly { appId: string; description: string }[];
}

/** Value object. What memory adds, read each time a system prompt is built. */
export interface PromptMemory {
  index: string | null;
  projects: readonly { name: string; location: string | null; summary: string }[];
}

/** Where a system prompt's material and memory come from. */
export interface PromptSources {
  material(): PromptMaterial;
  memory(): PromptMemory;
  /** The fixed part may be stale: the installed apps changed. */
  onChanged(listener: () => void): void;
}

/**
 * The fixed part of a system prompt, the same for every session of the
 * agent. With `setup`, only what a session's setup counts
 * (docs/concepts/sessions.md#setup): the agent's own instructions, the
 * charter and the identity, without the runtime facts and the installed
 * apps, which change with the instance rather than with the agent.
 */
export function buildPromptPrefix(
  agent: PromptAgent,
  material: PromptMaterial,
  options: { setup?: boolean } = {},
): string {
  // An app agent's YAML is its complete base prompt. Rome's identity, policy,
  // tools, and app catalog are core-agent concerns and must not silently
  // constrain an app author's agent.
  if (agent.owner === "app") return agent.systemPromptPrefix.trim();

  const sections: string[] = [];

  // The asking guidance joins the agent's own block on purpose: the tool
  // description, a bottom-of-prompt mention, and a standalone top-level section
  // all proved too low-salience to reliably flip the default "ask in prose"
  // behavior; instructions in the agent's own block carry more weight.
  const ownBlock: string[] = [];
  if (agent.systemPromptPrefix) ownBlock.push(agent.systemPromptPrefix.trim());
  if ((agent.actions ?? []).includes("*")) ownBlock.push(ASKING_SECTION);
  if (ownBlock.length > 0) sections.push(ownBlock.join("\n\n"));

  if (material.charter) sections.push(`# Charter\n\n${material.charter}`);
  if (material.identity) sections.push(markdownSection("Identity", material.identity));
  if (resolveAgentPolicy(agent).loadMemory && !options.setup) {
    sections.push(runtimeSection(material.runtime));
  }

  // Every core agent, because these executables are global runtime capabilities.
  sections.push(COMMAND_LINE_TOOLS_SECTION);

  const installedApps = options.setup ? null : installedAppsSection(material.installedApps);
  if (installedApps) sections.push(installedApps);

  return sections.join(SECTION_DIVIDER);
}

/** An app's agent gets only what it declares, so memory is a core agent's. */
export function carriesMemory(agent: PromptAgent): boolean {
  return agent.owner === "core" && resolveAgentPolicy(agent).loadMemory;
}

export function buildSystemPrompt(input: {
  prefix: string;
  owner: PromptAgent["owner"];
  memory: PromptMemory | null;
  contextSuffix?: string;
  widgets: WidgetDrawing;
}): string {
  const sections = [input.prefix];
  if (input.memory?.index) sections.push(markdownSection("Memory", input.memory.index));
  if (input.memory && input.memory.projects.length > 0) {
    sections.push(projectsSection(input.memory.projects));
  }
  if (input.contextSuffix) sections.push(input.contextSuffix);
  const prompt = sections.join("\n\n");

  return input.owner === "core" && input.widgets === "card"
    ? `${prompt}${SECTION_DIVIDER}${DIAGRAMS_SECTION}`
    : prompt;
}

/** The first paragraph, within the limit, or null when the file has none. */
export function projectSummary(markdown: string): string | null {
  const blocks = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const paragraphLines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (paragraphLines.length === 0) continue;

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

// Ask only when the answer would change the direction of the work, state a short
// plan before long work, and ask through the `ask_question` card. The tool is
// registered per session where widgets show, which a fixed part cannot see, so
// the `*` action grant stands in for "should reach for the card".
const ASKING_SECTION = [
  "# Asking The Guardian For Input",
  "",
  "Ask a clarifying question only when the answer would significantly change the direction of the work. Otherwise, proceed with the approach you recommend and briefly state the assumptions you made, so the guardian can redirect you.",
  "",
  "Before you start a long-running task (many steps or several minutes of work), state your plan, then start without waiting for approval, so the guardian can correct you early. Write the plan like ASD-STE100 Simplified Technical English: a few short, direct sentences, one action each, no filler. If you already show the plan as a todo list, do not repeat it in prose.",
  "",
  "When you do need to ask, use the `ask_question` tool — never write the questions in your text reply. Keep to the few questions that matter, and offer concrete options when the likely answers are enumerable.",
].join("\n");

const COMMAND_LINE_TOOLS_SECTION = [
  "# Command Line Tools",
  "",
  "- A global `discord` CLI is available to access Discord through Rome's connected bot. When a task requires current information from this connected Discord environment—such as channel history, messages, channels, threads, members, roles, or guild configuration—or a requested Discord management operation, prefer `discord api` over memory because it is live and authoritative. Run `discord api --help` when needed.",
  '- Run `rome-node help` to learn the remote computer CLI and `rome-node help device run` for action arguments and result handling. Use `rome-node device` to list authorized remote computers. Authorization does not mean online. Use `rome-node device describe <id>` to query its platform and supported actions. Execute a program with `rome-node device run <id> exec --args \'{"command":"git","args":["status"],"cwd":"/workspace"}\'`. On macOS/Linux, read files with cat and list directories with ls. On Windows, explicitly invoke powershell.exe with Get-Content, Set-Content, or Get-ChildItem. Use an explicit shell for redirection or pipelines. Check exitCode, stderr, and truncated output. Never automatically retry an unknown outcome: a local timeout does not cancel the remote process. Never read or print device credential files.',
].join("\n");

function runtimeSection(runtime: RuntimeFacts): string {
  const lines = [
    "# Runtime Context",
    "",
    `- Active profile directory: \`${runtime.profileDir}\``,
    `- Profile memory directory: \`${runtime.profileMemoryDir}\``,
    `- Custom app authoring directory: \`${runtime.customAppAuthoringDir}\``,
    `- Installed apps directory: \`${runtime.installedAppsDir}\``,
    `- Repo seed apps directory: \`${runtime.repoAppsDir}\``,
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
    `- In the agent browser, visit \`${runtime.internalApiBaseUrl}\` to open the Rome dashboard, or \`${runtime.internalApiBaseUrl}/apps/<appId>\` to use a specific app.`,
  ];

  if (runtime.docsDir) {
    lines.push(
      "",
      `Rome's docs are in \`${runtime.docsDir}\`. Search them before answering whether Rome supports something.`,
    );
  }

  if (runtime.publicOrigin) {
    lines.push(
      "",
      `Your public web address is \`${runtime.publicOrigin}\`\. It's the address to share with the guardian or hand to external services (e.g. OAuth redirects, links you send out).`,
    );
  }

  if (runtime.emailAddress) {
    lines.push(
      "",
      `Your email address: \`${runtime.emailAddress}\`. `,
      `You may use this email address to sign up for any newsletters, waitlists, services, or accounts needed to complete the task. You may receive and use verification emails, links, or codes for those signups.`,
    );
  }

  return lines.join("\n");
}

/**
 * The installed-app catalog, for every core agent and not just main. It also
 * carries the connector catalog: the `connector` app's description lists the
 * connectable toolkits and their `connector_proxy` API hosts, so an agent that
 * can't see this section can't pick connectors.
 */
function installedAppsSection(apps: PromptMaterial["installedApps"]): string | null {
  if (apps.length === 0) return null;
  return [
    "# Installed Apps",
    "",
    ...apps.map((app) => `- \`${app.appId}\`: ${app.description}`),
  ].join("\n");
}

function projectsSection(projects: PromptMemory["projects"]): string {
  const lines = projects.map((project) =>
    project.location
      ? `- \`${project.name}\` (\`${project.location}\`): ${project.summary}`
      : `- \`${project.name}\`: ${project.summary}`,
  );
  return ["# Projects", "", ...lines].join("\n");
}

function markdownSection(title: string, content: string): string {
  const headingPattern = new RegExp(`^#\\s+${title}(?:\\s|$)`, "i");
  return headingPattern.test(content) ? content : `# ${title}\n\n${content}`;
}
