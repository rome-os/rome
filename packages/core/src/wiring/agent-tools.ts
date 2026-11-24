// Every agent tool core offers, by the dashboard page it stands for. Each page
// declares its tools in one file of its context (connections/agent-tools.ts,
// routines/agent-tools.ts), or beside its routes in api/agent-tools/ when its
// context may not import apps/ (AI Tools, of the agent context); the wiring
// hands each page its deps once and registers the tools in the main process.
// How to add a tool:
// docs/concepts/actions.md#core-agent-tools.

import type { AgentTool } from "../apps/actions/agent-tool.js";
import type { ActionRegistry } from "../apps/actions/types.js";
import { type OwnerOfChat, whoMayAsk } from "../apps/actions/who-may-ask.js";
import { connectionTools } from "../connections/agent-tools.js";
import { routineTools } from "../routines/agent-tools.js";
import { aiToolTools } from "../api/agent-tools/ai-tools.js";
import { deviceTools } from "../connections/device/agent-tools.js";

const PAGES = {
  connections: connectionTools,
  routines: routineTools,
  aiTools: aiToolTools,
  devices: deviceTools,
};

type Page = keyof typeof PAGES;

/** The deps each page's tools take. */
export type AgentToolDeps = {
  [P in Page]: (typeof PAGES)[P] extends ReadonlyArray<AgentTool<infer D>> ? D : never;
};

/** Every agent tool core offers. */
export const agentTools: ReadonlyArray<AgentTool<never>> = Object.values(PAGES).flat();

/** The names of core's agent tools, which run in the main process as a root. */
export const agentToolNames: ReadonlySet<string> = new Set(agentTools.map((tool) => tool.name));

/** Each older name a tool took over, to the tool's name. */
export const agentToolOlderNames: ReadonlyMap<string, string> = new Map(
  agentTools.flatMap((tool) => tool.olderNames.map((older) => [older, tool.name] as const)),
);

/** Registers every agent tool, each page's over its deps. `ownerOfChat` is
 * what the check of who may ask reads. */
export function registerAgentTools(
  actions: Pick<ActionRegistry, "register">,
  ownerOfChat: OwnerOfChat,
  deps: AgentToolDeps,
): void {
  const check = whoMayAsk(ownerOfChat);
  for (const page of Object.keys(PAGES) as Page[]) {
    const tools = PAGES[page] as ReadonlyArray<AgentTool<AgentToolDeps[Page]>>;
    for (const tool of tools) actions.register(tool.action(deps[page], check));
  }
}
