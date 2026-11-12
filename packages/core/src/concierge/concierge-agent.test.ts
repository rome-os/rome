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
  it("renames through the core action instead of editing the setting-owned identity line", () => {
    expect(concierge.actions).toContain("core:set_agent_name");
    for (const prompt of [
      concierge.systemPromptPrefix,
      (
        parseYaml(readFileSync(resolve(here, "../../agents/main.yaml"), "utf8")) as {
          systemPromptPrefix: string;
        }
      ).systemPromptPrefix,
    ]) {
      expect(prompt).toContain("`core:set_agent_name` with `execute_action`");
      expect(prompt).toContain("Do not edit the `Agent Name` line");
    }
  });

  it("reads an automated input as a standing request, not the guardian's words", () => {
    const prompt = concierge.systemPromptPrefix;
    expect(prompt).toContain("An `<automated_input source=");
    expect(prompt).toContain("The guardian did not write it and does not see it");
  });

  it("makes recurring work a scheduled task, never a routine posting into this chat", () => {
    const prompt = concierge.systemPromptPrefix;
    expect(prompt).toContain("is a scheduled task: `chat_start` with a `schedule`");
    expect(prompt).toContain("Never set up a generic routine that posts into this chat");
    // A brief that names a place to send to has the task chat deliver past you.
    expect(prompt).toContain("The brief says what to do, never where to send it");
  });

  it("never tells the Concierge a forward needs `answers` or passes the guardian's words on", () => {
    const prompt = concierge.systemPromptPrefix;
    expect(prompt).not.toMatch(/`chat_forward` (?:are|is) refused/);
    expect(prompt).not.toContain("with `chat_send` or `chat_forward`");
    expect(prompt).toContain("`chat_forward` passes nothing on");
  });

  it("reports a finished task by forwarding its conclusion, never its whole report", () => {
    const lines = concierge.systemPromptPrefix.split("\n");
    const rule = (start: string) => lines.find((line) => line.startsWith(start)) ?? "";
    const finished = rule('- `task_finished` with initiator="concierge"');
    for (const text of [
      "forward the task chat's conclusion with `chat_forward`",
      "the forwarded message shows its source chat, which opens the details",
      "Never paste or retell the rest of the answer",
      "refuses because the answer has no conclusion or it is too long",
      "at most two short sentences",
      "with `task` set to the task's id so it joins the task's thread",
      "deliver the result in ONE message",
      "(`full: true`) only when the guardian explicitly asked for the full text in a message they sent this turn",
      "A failed or stopped task: say so plainly",
    ])
      expect(finished).toContain(text);
    expect(rule("- In a task event, `conclusion:`")).toContain(
      "the task chat's own conclusion, whole",
    );
    expect(rule("- When the guardian asks for content you write yourself")).toContain(
      "never the whole report, unless the guardian explicitly asks for the full text",
    );
    expect(concierge.systemPromptPrefix).toContain(
      "Nor does a forwarded conclusion that asks the guardian something",
    );
    for (const obsolete of [
      "Long content the guardian asked for: `chat_forward`",
      "(`say` with format long, or `chat_forward`)",
      "A short finding: 1 to 3 bubbles in your own words",
    ])
      expect(concierge.systemPromptPrefix).not.toContain(obsolete);
  });

  it("tells the Concierge to write a task's brief in the guardian's language", () => {
    const rule =
      concierge.systemPromptPrefix
        .split("\n")
        .find((line) => line.startsWith("- Everything else is a task")) ?? "";
    expect(rule).toContain("Write it in the guardian's language");
    expect(rule).toContain("writes its conclusion in the language of its brief");
  });

  it("shows task questions and approvals as live cards without relaying card answers", () => {
    const rule = concierge.systemPromptPrefix
      .split("\n")
      .find((line) => line.startsWith("- `task_needs_input`"));
    for (const text of [
      "turn_end:completed question",
      "`approval`",
      "`chat_card`",
      "Do not restate the question, options or approval",
      "do not relay that answer",
      "instead type an answer in this chat",
      "pass it on with `chat_send`",
    ])
      expect(rule).toContain(text);
    // Rome keeps the status; the prompt never asks for one by hand.
    expect(concierge.systemPromptPrefix).not.toContain("needs_user");
    const taskList = concierge.systemPromptPrefix.split("# Task list\n")[1];
    expect(taskList).toContain("You never set a status");
    // Only a card makes a task wait for the guardian.
    expect(taskList).toContain("with a card, never in plain text");
  });

  it("can find and delete the routine that watches a task row", () => {
    expect(concierge.actions).toContain("system:search_routine");
    expect(concierge.actions).toContain("system:delete_routine");
    // The names are the system app's own actions, not a guess at them.
    expect(actionName("search-routine")).toBe("search_routine");
    expect(actionName("delete-routine")).toBe("delete_routine");
  });

  it("tells dream to preserve the setting-owned agent name", () => {
    const dream = parseYaml(
      readFileSync(resolve(here, "../../../../rome_apps/dream/src/agents/dream.yaml"), "utf8"),
    ) as { systemPromptPrefix: string };
    expect(dream.systemPromptPrefix).toContain(
      "Preserve the `Agent Name` line in `memory/IDENTITY.md` unchanged",
    );
  });

  it("preserves saved follow settings before applying the requested changes", () => {
    const prompt = concierge.systemPromptPrefix;
    for (const text of [
      "find the service's entry and the matching target in its `capabilities.watch.follows`",
      "For a NEW follow only, start with the catalog defaults",
      "use its `kinds[].on`, `options` and `preference` for `defaults` and `defaultText`",
      "Fall back to a catalog default only for a setting missing from that follow",
      "Keep saved false values, empty lists and a cleared preference",
      "Apply changes the guardian already asked for on top",
      "Do not reset unmentioned settings",
    ])
      expect(prompt).toContain(text);
    expect(prompt).not.toContain("with the catalog's default kinds in `defaults`");
  });

  it("uses the follow settings card after the Concierge connect card succeeds", () => {
    const prompt = concierge.systemPromptPrefix;
    expect(concierge.actions).not.toContain("connector:connector_connect");
    expect(concierge.actions).not.toContain("connector:connector_login");
    for (const text of [
      "show the guardian `connect_card` with the `service` name",
      'After `<service_connected service="…"/>`, use this card flow when the guardian asked to follow the service',
      "do not save a follow before their answer",
      "ask with ONE `ask_question` card built from the list's watch catalog",
      "Ask first when the target names something the guardian has not, such as which repositories",
      "Include that target question in the card when its settings are known",
      "otherwise ask for the target before building the settings card",
      "Map selected labels back to kind keys",
      "call `core:concierge_follow` to create the follow or `core:concierge_following_configure` to change it",
    ])
      expect(prompt).toContain(text);
  });

  it("reads history and checks unfinished work on quota recovery", () => {
    const prompt = concierge.systemPromptPrefix;
    expect(concierge.actions).toContain("system:fetch_channel_history");
    for (const text of [
      "<quota_recovery>",
      "even without `<continuation>`",
      "Do not repeat confirmed work",
      "ask the guardian",
      "`say` only and end with `done`",
    ])
      expect(prompt).toContain(text);
  });

  it("marks a secret private, since every message can reach the lock screen, and sends fewer messages", () => {
    const section = concierge.systemPromptPrefix.slice(
      concierge.systemPromptPrefix.indexOf("# How you speak"),
      concierge.systemPromptPrefix.indexOf("# What you do yourself"),
    );
    for (const text of [
      "Every message you send also goes to their phone",
      "in your reply to a message they sent",
      "lock screen",
      "code, password, token or other secret, even one they asked for",
      "`private: true`",
      "send fewer of them",
    ])
      expect(section).toContain(text);
  });

  it("links every defer for a task by its taskId and reads its wake-ups and batches", () => {
    const prompt = concierge.systemPromptPrefix;
    const section = prompt.slice(prompt.indexOf("# Task list"));
    expect(section).toContain("`defer` with its `taskId`");
    expect(section).toContain("`deadline`");
    expect(section).toContain("<task_review>");
    expect(section).toContain("`system:search_routine`");
    expect(section).toContain("`system:delete_routine`");
    expect(section).toContain("<task_events>");
    // A guardian's "stop" or "archive" by name is resolved against the list.
    expect(section).toContain('`Stop "Title"`');
    expect(section).toContain("`task_list`");
    expect(section).toContain("first 6 characters of the row id");
    expect(section).toContain("`stop: true`");
    expect(section).toContain("`archived: true`");
    expect(section).toContain("ask which one in a single bubble");
    expect(prompt).not.toContain("task_action");
    expect(section).toContain("needs no write unless the summary changed");
    // The task list rules are one separate section after the existing ones.
    expect(prompt.indexOf("# Task list")).toBeGreaterThan(prompt.indexOf("# Interruptions"));
    expect(prompt.match(/# Task list/g)).toHaveLength(1);
  });
});
