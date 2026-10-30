import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const concierge = parseYaml(readFileSync(resolve(here, "../../agents/concierge.yaml"), "utf8")) as {
  actions: string[];
  systemPromptPrefix: string;
};
const actionName = (action: string) =>
  (
    parseYaml(
      readFileSync(
        resolve(here, `../../../../rome_apps/system/src/actions/${action}/action.yaml`),
        "utf8",
      ),
    ) as { name: string }
  ).name;

describe("the Concierge agent", () => {
  it("can find and delete the routine that watches a task row", () => {
    expect(concierge.actions).toContain("system:search_routine");
    expect(concierge.actions).toContain("system:delete_routine");
    // The names are the system app's own actions, not a guess at them.
    expect(actionName("search-routine")).toBe("search_routine");
    expect(actionName("delete-routine")).toBe("delete_routine");
  });

  it("names every defer for a row with task:<id> and reads its wake-ups and batches", () => {
    const prompt = concierge.systemPromptPrefix;
    const section = prompt.slice(prompt.indexOf("# Task list"));
    expect(section).toContain("name containing `task:<id>`");
    expect(section).toContain("`system:search_routine`");
    expect(section).toContain("`system:delete_routine`");
    expect(section).toContain("<task_events>");
    // A guardian's "stop" or "archive" by name is resolved against the list.
    expect(section).toContain('`Stop "Title"`');
    expect(section).toContain("`task_list`");
    expect(section).toContain("first 6 characters of the row id");
    expect(section).toContain("`chat_stop`");
    expect(section).toContain("`archived: true`");
    expect(section).toContain("ask which one in a single bubble");
    expect(prompt).not.toContain("task_action");
    expect(section).toContain("ONE `task_upsert`");
    // The task list rules are one separate section after the existing ones.
    expect(prompt.indexOf("# Task list")).toBeGreaterThan(prompt.indexOf("# Interruptions"));
    expect(prompt.match(/# Task list/g)).toHaveLength(1);
  });
});
