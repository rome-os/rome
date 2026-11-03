import { buildTraceSnapshot } from "../trace/build-snapshot.js";
import type { ShowcaseBundle } from "../trace/portable.js";
import { SHOWCASE_BUNDLE_SCHEMA, SHOWCASE_BUNDLE_VERSION } from "../trace/portable.js";
import type { TraceEventDto } from "../trace/types.js";

const tripPlannerBlocks: TraceEventDto[] = [
  {
    type: "session_init",
    agent: "main",
    sessionId: "sample-trip-planner",
    userPrompt: "build an app for me to plan a trip",
  },
  {
    type: "turn_start",
    agent: "main",
    turnId: "sample-trip-planner-turn-1",
    sessionId: "sample-trip-planner",
    userPrompt: "build an app for me to plan a trip",
  },
  {
    type: "text",
    agent: "main",
    content: "I'll gather a few details and line up the app-building workflow.",
  },
  {
    type: "tool_use",
    agent: "main",
    tool: "ask_user_question",
    id: "sample-tool-1",
    input: {
      questions: [
        {
          id: "focus",
          type: "multi",
          question: "What should the trip planner focus on most?",
          options: [
            { id: "itinerary", text: "Itinerary / day-by-day schedule" },
            { id: "ideas", text: "Destination ideas & inspiration" },
            { id: "packing", text: "Packing checklist" },
          ],
        },
      ],
    },
    startedAt: "2026-06-07T17:00:00.000Z",
  },
  {
    type: "tool_result",
    agent: "main",
    tool: "ask_user_question",
    toolUseId: "sample-tool-1",
    output: {
      status: "success",
      selected: ["itinerary", "ideas", "packing"],
    },
    endedAt: "2026-06-07T17:00:00.105Z",
  },
  {
    type: "tool_use",
    agent: "main",
    tool: "read_skill",
    id: "sample-tool-2",
    input: { skill_name: "create-app" },
    startedAt: "2026-06-07T17:00:00.110Z",
  },
  {
    type: "tool_result",
    agent: "main",
    tool: "read_skill",
    toolUseId: "sample-tool-2",
    output: { status: "success", summary: "Loaded the app-building workflow." },
    endedAt: "2026-06-07T17:00:00.166Z",
  },
  {
    type: "result",
    agent: "main",
    content: "Ready to build after the answers are submitted.",
    accounting: {
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: {
        cacheReadTokens: 51305,
        cacheWriteTokens: 5835,
        inputTokens: 4,
        outputTokens: 762,
      },
      context: { usedTokens: 28950, windowTokens: 1000000 },
      costUsd: 0.2436,
    },
  },
  {
    type: "turn_end",
    agent: "main",
    turnId: "sample-trip-planner-turn-1",
    status: "completed",
    durationMs: 21000,
  },
];

const tripPlannerSnapshot = buildTraceSnapshot({
  idPrefix: "sample-trip-planner",
  blocks: tripPlannerBlocks,
});

const gitResetBlocks: TraceEventDto[] = [
  {
    type: "session_init",
    agent: "main",
    sessionId: "sample-git-reset",
    userPrompt: "reset the local changes so that the repo is in sync with the remote",
  },
  {
    type: "turn_start",
    agent: "main",
    turnId: "sample-git-reset-turn-1",
    sessionId: "sample-git-reset",
    userPrompt: "reset the local changes so that the repo is in sync with the remote",
  },
  {
    type: "text",
    agent: "main",
    content: "I'll first check the current state of the repo before doing anything destructive.",
  },
  {
    type: "tool_use",
    agent: "main",
    tool: "Bash",
    id: "git-1",
    input: { command: 'git status && echo "---REMOTE---" && git remote -v' },
    startedAt: "2026-06-07T17:10:00.000Z",
  },
  {
    type: "tool_result",
    agent: "main",
    tool: "Bash",
    toolUseId: "git-1",
    output: { status: "success", exit_code: 0, stdout: "20 files changed, 6 untracked" },
    endedAt: "2026-06-07T17:10:00.054Z",
  },
  {
    type: "tool_use",
    agent: "main",
    tool: "Bash",
    id: "git-2",
    input: { command: "pwd && git rev-parse --show-toplevel" },
    startedAt: "2026-06-07T17:10:00.060Z",
  },
  {
    type: "tool_result",
    agent: "main",
    tool: "Bash",
    toolUseId: "git-2",
    output: { status: "success", exit_code: 0, stdout: "/home/rome/repo" },
    endedAt: "2026-06-07T17:10:00.113Z",
  },
  {
    type: "text",
    agent: "main",
    content:
      "This will permanently discard all local changes shown above (20 modified files and 6 untracked files). You explicitly asked for this, so I'll proceed: fetch from remote, hard-reset to `origin/master`, and remove untracked files.",
  },
  {
    type: "tool_use",
    agent: "main",
    tool: "Bash",
    id: "git-3",
    input: { command: "git fetch origin && git reset --hard origin/master && git clean -fd" },
    startedAt: "2026-06-07T17:10:00.120Z",
  },
  {
    type: "tool_result",
    agent: "main",
    tool: "Bash",
    toolUseId: "git-3",
    output: {
      status: "success",
      exit_code: 0,
      stdout: "HEAD is now at 9daee1e Update interrogation/narration actions and GM prompts",
    },
    endedAt: "2026-06-07T17:10:00.769Z",
  },
  {
    type: "text",
    agent: "main",
    content:
      "Done. The repo is now in sync with the remote.\n\n- Hard-reset `master` to `origin/master` (now at `9daee1e Update interrogation/narration actions and GM prompts`)\n- Discarded all 20 modified tracked files\n- Removed untracked files and the untracked `src/actions/summon-info/` directory\n\nWorking tree is clean and up to date with `origin/master`.",
  },
  {
    type: "result",
    agent: "main",
    content: "Working tree is clean and up to date with origin/master.",
    accounting: {
      provider: "anthropic",
      model: "claude-opus-4-8[1m]",
      usage: {
        cacheReadTokens: 132045,
        cacheWriteTokens: 8120,
        inputTokens: 9,
        outputTokens: 412,
      },
      context: { usedTokens: 140174, windowTokens: 1000000 },
      costUsd: 0.1982,
    },
  },
  {
    type: "turn_end",
    agent: "main",
    turnId: "sample-git-reset-turn-1",
    status: "completed",
    durationMs: 21000,
  },
];

const gitResetSnapshot = buildTraceSnapshot({
  idPrefix: "sample-git-reset",
  blocks: gitResetBlocks,
});

export const defaultSampleBundle: ShowcaseBundle = {
  schema: SHOWCASE_BUNDLE_SCHEMA,
  version: SHOWCASE_BUNDLE_VERSION,
  exportedAt: "2026-06-07T17:00:00.000Z",
  collections: [
    {
      id: "sample-agent-trace-basics",
      title: "Agent Trace Basics",
      description: "Static sample traces that demonstrate the Showcases trace viewer.",
      source: "sample",
      traces: [
        {
          id: "sample-git-reset-trace",
          title: "Reset local changes to match remote",
          description: "A 3-step Terminal turn — the chat-replica reference example.",
          capturedAt: "2026-06-07T17:10:00.000Z",
          blocks: gitResetBlocks,
          snapshot: gitResetSnapshot,
          summary: gitResetSnapshot.summary,
          metadata: {
            tags: ["sample", "git", "terminal"],
            userPrompt: "reset the local changes so that the repo is in sync with the remote",
            romeTraceFormatVersion: 1,
          },
        },
        {
          id: "sample-trip-planner-trace",
          title: "Trip Planner Planning Trace",
          description: "A compact trace similar to the app-building planning example.",
          capturedAt: "2026-06-07T17:00:00.000Z",
          blocks: tripPlannerBlocks,
          snapshot: tripPlannerSnapshot,
          summary: tripPlannerSnapshot.summary,
          metadata: {
            tags: ["sample", "trip-planner", "app-building"],
            romeTraceFormatVersion: 1,
          },
        },
      ],
    },
  ],
};
