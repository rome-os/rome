// Serves the model a session's tools in their groups. A tool turns a
// model's call into a call on a port and the answer into a tool result. What
// this agent may call, running an action or a subagent and scheduling a wake-up
// stay with those ports. Agent model: docs/concepts/agents.md.

import type { AgentActions } from "../domain/agent-action.js";
import type { AgentComputerUse } from "../domain/computer-use.js";
import type { AgentLog } from "../domain/agent-log.js";
import type {
  RomeTool,
  RomeToolDefinition,
  RomeToolGroup,
  RomeTools,
} from "../domain/rome-tools.js";
import type { SkillCatalog } from "../domain/skill.js";
import type { TurnFacts } from "../domain/turn-facts.js";
import type { Subagents } from "../domain/subagent.js";
import { actionTools } from "./action-tools.js";
import { askUserTools, type DeferTool } from "./ask-user-tools.js";
import { romeToolRunner } from "./rome-tool-runner.js";
import { skillTools } from "./skill-tools.js";
import { subagentTools } from "./subagent-tools.js";
import { computerTools } from "./computer-tools.js";

export interface RomeToolsOptions {
  /** The turns the tools serve. */
  turn: TurnFacts;
  actions: AgentActions;
  skills: Pick<SkillCatalog, "list">;
  subagents: Subagents;
  widgetsShow: boolean;
  log: AgentLog;
  /** Absent for a session with no live thread to wake. */
  defer?: DeferTool;
  /** Served in the ask-user group after `defer`, in the order given. */
  sessionTools?: readonly RomeTool[];
  /** The agent's `ask_question` card says which message it replies to. */
  repliesTo?: boolean;
  computerUse?: AgentComputerUse;
}

function toDefinition({
  name,
  description,
  inputSchema,
  endsTurn,
  formerNames,
}: RomeTool): RomeToolDefinition {
  return {
    name,
    description,
    inputSchema,
    ...(endsTurn !== undefined ? { endsTurn } : {}),
    ...(formerNames ? { formerNames } : {}),
  };
}

export function createRomeTools(options: RomeToolsOptions): RomeTools {
  const { turn, actions, skills, subagents, widgetsShow, log, defer, sessionTools, repliesTo } =
    options;
  const run = romeToolRunner(log);
  const groups: Record<RomeToolGroup, RomeTool[]> = {
    actions: actionTools(actions, turn, widgetsShow, run, log),
    subagents: subagentTools(subagents, run),
    skills: skillTools(skills, run),
    ask_user: askUserTools({ turn, widgetsShow, defer, sessionTools, repliesTo, run }),
    computer: computerTools(options.computerUse, turn),
  };

  return {
    listTools(group) {
      return Object.freeze(groups[group].map(toDefinition));
    },
    async callTool(group, name, input = {}, context) {
      const tool = groups[group].find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }
      return await tool.handler(input, context);
    },
  };
}
