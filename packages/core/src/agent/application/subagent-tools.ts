// The tools an agent hands work to its subagents with, one per subagent.

import type { RomeTool } from "../domain/rome-tools.js";
import { subagentToolName, type Subagents } from "../domain/subagent.js";
import type { RomeToolRunner } from "./rome-tool-runner.js";

export function subagentTools(subagents: Subagents, run: RomeToolRunner): RomeTool[] {
  return subagents.list().map((subagent) => {
    const name = subagentToolName(subagent.name);
    return {
      name,
      description: `Delegate a task to the "${subagent.name}" subagent: ${subagent.description}`,
      inputSchema: {
        properties: {
          prompt: {
            type: "string",
            description: "The task/prompt to send to the subagent",
          },
          resumeSessionId: {
            type: "string",
            description: "Explicit Child session ID to resume; omitted starts a fresh session",
          },
        },
        required: ["prompt"],
      },
      handler: (input, context) =>
        run(name, input, (parsed) => {
          if (!context?.toolUseId) {
            throw new Error(`Subagent tool "${name}" is missing its tool-use identity`);
          }
          return subagents.run(subagent.name, parsed, context);
        }),
    };
  });
}
