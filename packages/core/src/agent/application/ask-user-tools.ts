// The tools that ask the person something or wait on them: `ask_question`,
// `defer`, and the session's own tools after them.

import type { AgentPolicy } from "../domain/agent-policy.js";
import { askQuestionToolOutput, parseAskQuestionInput } from "../domain/ask-question.js";
import { parseDeferInput, type WakeUp } from "../domain/defer.js";
import type { RomeTool } from "../domain/rome-tools.js";
import type { TurnFacts } from "../domain/turn-facts.js";
import type { RomeToolRunner } from "./rome-tool-runner.js";

/** What `defer` is served with, for a session with a live thread to wake. */
export interface DeferTool {
  /** Schedule a wake back into the thread `turn` runs in. */
  schedule(turn: TurnFacts, wakeUp: WakeUp): Promise<unknown>;
  /** The agent's text never reaches the guardian, so `defer` asks for no confirmation in text. */
  finalText: AgentPolicy["finalText"];
  /** An event wait needs `waitingFor` and a `deadline` (agent-policy.ts). Absent: it needs neither. */
  taskChecks?: boolean;
}

const DEFER_DESCRIPTION =
  "Schedule a wake-up later in this same conversation — use it when you're " +
  "watching something that isn't ready yet (a CI run, a build, a reply) instead of ending the turn empty. " +
  "Give a short `name` for what you're watching (it becomes the routine's name) and exactly one of " +
  "`afterMinutes`, `at`, or `event`. Prefer `event` when something announces completion (CI finished, a PR " +
  "merged, a reply): it wakes as soon as a matching event-bus event is published, once, on the first match. " +
  "Look up the event name and payload fields with the search_event_catalog action first. " +
  "For a `subscribable` type, filter on one of its `keys` (e.g. repository.full_name); defer then subscribes " +
  "at the provider and fails with the reason if it can't. Events are not replayed and a new subscription " +
  "only sees future events: after an event defer, check the current state once more, and if what you're " +
  "waiting for already happened, handle it now. When you wake you're pinged back in this thread with the whole conversation still in context, so " +
  "just re-evaluate and either finish or `defer` again (minimum one minute, no limit on re-defers). ";

const DEFER_END_OF_TURN =
  "After calling defer, write one short line confirming you'll keep watch, then end your turn.";
const DEFER_END_OF_TURN_TEXT_PRIVATE =
  "After calling defer, end your turn. It needs no confirmation.";

function deferTool(defer: DeferTool, turn: TurnFacts, run: RomeToolRunner): RomeTool {
  return {
    name: "defer",
    description:
      DEFER_DESCRIPTION +
      (defer.taskChecks
        ? "An event wait also needs `waitingFor` and a `deadline`, when it wakes anyway if the event never came. "
        : "An event wait has no timeout. ") +
      (defer.finalText === "private" ? DEFER_END_OF_TURN_TEXT_PRIVATE : DEFER_END_OF_TURN),
    inputSchema: {
      type: "object",
      required: ["name", "note"],
      properties: {
        note: {
          type: "string",
          description:
            "A self-contained note to yourself, delivered when you wake: why you are waiting, what to do then, and the concrete targets (links, message ids, task ids). " +
            "Write it for a reader who has not seen this conversation: the session that wakes may be a newer one, without this turn in its context.",
        },
        name: {
          type: "string",
          description:
            'A short name for what you\'re watching, e.g. "GitHub CI run" or "Dana\'s reply". Name what, never when: ' +
            'no time or duration such as "(2 minutes)", since the wake-up time is shown beside it. Stored as the ' +
            "routine's name and shown on the Routines page; you'll be pinged back in this same conversation when the time is up.",
        },
        afterMinutes: {
          type: "integer",
          minimum: 1,
          description:
            "Minutes from now until wakeup, e.g. 5 (five minutes) or 120 (two hours). Minimum 1. Provide exactly one of afterMinutes, at, or event.",
        },
        at: {
          type: "string",
          description:
            "Absolute wakeup time as an ISO 8601 instant, e.g. 2026-06-25T14:30:00Z. Provide exactly one of afterMinutes, at, or event.",
        },
        ...(defer.taskChecks
          ? {
              taskId: {
                type: "string",
                description:
                  "Optional: the task this check is for, from your task list. The task shows as later until you wake, and stopping or archiving it cancels the check.",
              },
            }
          : {}),
        event: {
          type: "object",
          description: defer.taskChecks
            ? "Wake on the next event-bus event that matches, or at its deadline if none comes. Provide exactly one of afterMinutes, at, or event."
            : "Wake on the next event-bus event that matches. Provide exactly one of afterMinutes, at, or event.",
          required: defer.taskChecks ? ["eventName", "waitingFor", "deadline"] : ["eventName"],
          properties: {
            eventName: {
              type: "string",
              description:
                "The exact event type, from search_event_catalog, e.g. provider:event:github.workflow_run.",
            },
            sourcePattern: {
              type: "string",
              description:
                "Optional: only match events from this source (an appId); a single * matches any run of characters.",
            },
            ...(defer.taskChecks
              ? {
                  waitingFor: {
                    type: "string",
                    description:
                      'A few words saying what you wait for, shown in the chat while you wait, e.g. "the CI run" or "Dana\'s reply".',
                  },
                  deadline: {
                    type: "string",
                    description:
                      "ISO 8601 instant: when to wake anyway if the event has not come, e.g. 2026-06-25T18:00:00Z.",
                  },
                }
              : {}),
            filter: {
              type: "array",
              description:
                "Optional payload conditions, AND-ed together. Each compares the payload value at a dot-path, as a string, for equality.",
              items: {
                type: "object",
                required: ["field", "equals"],
                properties: {
                  field: {
                    type: "string",
                    description: "Dot-path into the payload, e.g. pull_request.number",
                  },
                  equals: { type: "string", description: "Value the field must equal" },
                },
              },
            },
          },
        },
      },
    },
    handler: (input) =>
      run("defer", input, () => {
        const parsed = parseDeferInput(input, Date.now(), {
          taskChecks: defer.taskChecks === true,
        });
        if (!parsed.ok) throw new Error(parsed.error);
        return defer.schedule(turn, parsed.wakeUp);
      }),
  };
}

/** `ask_question`, then `defer` where a thread can be woken, then the session tools. */
export function askUserTools(input: {
  turn: TurnFacts;
  widgetsShow: boolean;
  defer?: DeferTool;
  sessionTools?: readonly RomeTool[];
  run: RomeToolRunner;
}): RomeTool[] {
  const { turn, widgetsShow, defer, sessionTools = [], run } = input;
  // `ask_question` is served everywhere: where no widget shows, the handler
  // relays the questions as a plain message, so the model routes clarifying
  // questions through it wherever it runs.
  const tools: RomeTool[] = [
    {
      name: "ask_question",
      // On a card the turn parks until the guardian answers; the plain-message
      // relay returns and the turn goes on.
      endsTurn: widgetsShow,
      description:
        "Ask the guardian one or more clarifying questions (single-choice, multi-choice, or short free-text), rendered as an interactive card in web chat or relayed as a plain message on other surfaces. Use it only when the answer would significantly change the direction of the work; otherwise proceed with your recommended approach and state your assumptions. When you do ask, use this tool rather than writing the questions in your text reply. Each call collects one set of questions, and the guardian's answers come back as the next turn. Prefer single-choice questions with concrete options when the likely answers are enumerable (set freeText so they can still type their own); use multi when several answers can apply at once.",
      inputSchema: {
        type: "object",
        required: ["questions"],
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            description: "Questions rendered together as one card.",
            items: {
              type: "object",
              required: ["id", "question", "type"],
              properties: {
                id: {
                  type: "string",
                  description: "Stable id; the answer references it.",
                },
                question: {
                  type: "string",
                  description: "The prompt shown to the guardian.",
                },
                type: {
                  type: "string",
                  enum: ["single", "multi", "text"],
                  description:
                    "single: pick exactly one option; multi: pick any number of options; text: free-form.",
                },
                options: {
                  type: "array",
                  items: { type: "string" },
                  description: "Required for single and multi; the choices. Ignored for text.",
                },
                defaults: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Choice questions only: option labels selected at first. Single allows at most one, multi allows zero or more. Every label must be in options.",
                },
                defaultText: {
                  type: "string",
                  description: "Text questions only: initial text the guardian can edit.",
                },
                optionDescriptions: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description:
                    "Choice questions only: short explanations keyed by existing option labels. Answers still use the labels, not the descriptions.",
                },
                freeText: {
                  type: "boolean",
                  description:
                    "single/multi only: also show a free-text box beneath the options, so the guardian can tap option(s) OR type their own answer. Use this for most choice questions — it keeps input cheap (a tap) without trapping them in your option set. Ignored for text.",
                },
                optional: {
                  type: "boolean",
                  description:
                    "If true, the guardian may leave this question blank without blocking submit (a blank answer is simply omitted from the results). Defaults to false — questions are required.",
                },
              },
            },
          },
        },
      },
      handler: (input) =>
        run("ask_question", input, async () => {
          const result = parseAskQuestionInput(input);
          if (!result.ok) throw new Error(result.error);
          return askQuestionToolOutput(result.questions, widgetsShow);
        }),
    },
  ];
  // `defer` injects an inbound message rather than drawing a widget, so it is
  // served wherever there is a live thread to wake.
  if (defer) tools.push(deferTool(defer, turn, run));
  tools.push(...sessionTools);
  return tools;
}
