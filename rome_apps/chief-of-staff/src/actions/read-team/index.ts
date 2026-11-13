import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { createDocumentsRepository, type TeamDocument } from "../../db/repositories/documents.js";

/** A document's heading and, when it is empty, the line that stands in its
 *  place, so the agent reads "not set yet" rather than a blank it might fill. */
const HEADINGS: Record<TeamDocument["name"], { title: string; empty: string }> = {
  roster: {
    title: "# Roster (source: the team roster)",
    empty: "_The roster is not set yet. Say you do not know the team rather than guess it._",
  },
  goals: {
    title: "# Goals (source: the goals document)",
    empty:
      "_The goals document is not set yet. Say you do not know the goals rather than guess them._",
  },
};

function render(documents: TeamDocument[]): string {
  return documents
    .map(({ name, body }) => {
      const heading = HEADINGS[name];
      const content = body.trim() ? body.trim() : heading.empty;
      return `${heading.title}\n\n${content}`;
    })
    .join("\n\n");
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return {
    config,
    inputSchema: { type: "object", properties: {} },
    async execute(): Promise<ActionResult> {
      const repo = createDocumentsRepository(deps.appContext.db);
      return { status: "ok", data: { team: render(repo.all()) } };
    },
  };
}
