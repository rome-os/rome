import type { DemoChat } from "./chats";

// Edited from the user-provided share linked in docs/dashboard-mock-mode.md.
export const appBuildingChat: DemoChat = {
  id: "mock-chat-build-app",
  name: "Build an app from an idea",
  project: "default",
  turns: [
    {
      at: "2026-09-15T17:00:00.000Z",
      prompt:
        "Please create a Rome app for issue triage that automatically labels issues, taking inspiration from this skill: https://mcpmarket.com/tools/skills/linear-issue-type-labeler. However, please consider and design for the following:\r\n1. Labels should not be limited to those in the skill; they should also account for the labels already defined in the GitHub repository.\r\n2. The UI should include a dashboard for configuring repositories and related settings.",
      reply:
        "I'll build a GitHub issue triage app with a repository dashboard. Before I start, let's choose when it runs and how it handles labels.",
      blocks: [
        {
          type: "pending_interaction",
          toolUseId: "demo-triage-design",
          appId: "core",
          render: {
            kind: "inline",
            componentId: "question-card",
            props: {
              questions: [
                {
                  id: "trigger",
                  question: "When should the app label an issue?",
                  type: "multi",
                  options: [
                    "Auto: when a new issue is opened (GitHub webhook)",
                    "Auto: also when an issue is edited/reopened",
                    "Manual: batch-triage existing issues from the dashboard",
                    "Manual: label a single issue by URL/number",
                  ],
                  freeText: true,
                },
                {
                  id: "apply_mode",
                  question: "Should it apply labels directly, or suggest for review?",
                  type: "single",
                  options: [
                    "Apply labels directly to the GitHub issue",
                    "Suggest only — I approve in the dashboard before it applies",
                    "Apply directly but post a comment explaining the reasoning",
                  ],
                  freeText: true,
                },
                {
                  id: "label_strategy",
                  question:
                    "How should the label set be built? (You mentioned combining the skill's types with the repo's own labels.)",
                  type: "single",
                  options: [
                    "Use the repo's existing GitHub labels + a built-in issue-type taxonomy (type/bug, type/feature, etc.), creating any missing type labels",
                    "Only ever apply labels that already exist in the repo (never create new ones)",
                    "Use repo labels as-is, and let me curate/enable which built-in taxonomy labels are allowed per repo in the dashboard",
                  ],
                  freeText: true,
                },
                {
                  id: "dimensions",
                  question: "Which label dimensions should the classifier assign?",
                  type: "multi",
                  options: [
                    "Type (bug / feature / enhancement / docs / question)",
                    "Priority (low / medium / high / critical)",
                    "Area / component (from repo's existing labels)",
                    "Needs-triage / needs-info flags",
                  ],
                  freeText: true,
                },
                {
                  id: "repo",
                  question:
                    "Which GitHub repo(s) do you want to wire up first for testing? (owner/name — optional, you can add later in the dashboard)",
                  type: "text",
                  optional: true,
                },
              ],
            },
            builtin: true,
          },
        },
      ],
    },
    {
      at: "2026-09-15T17:02:00.000Z",
      prompt: [
        {
          type: "interaction_result",
          toolUseId: "demo-triage-design",
          output: {
            answers: [
              {
                questionId: "trigger",
                value:
                  "Auto: when a new issue is opened (GitHub webhook), Auto: also when an issue is edited/reopened, Manual: batch-triage existing issues from the dashboard, Manual: label a single issue by URL/number",
              },
              {
                questionId: "apply_mode",
                value: "Apply labels directly to the GitHub issue",
              },
              {
                questionId: "label_strategy",
                value:
                  "Use the repo's existing GitHub labels + a built-in issue-type taxonomy (type/bug, type/feature, etc.), creating any missing type labels",
              },
              {
                questionId: "dimensions",
                value:
                  "Type (bug / feature / enhancement / docs / question), Priority (low / medium / high / critical), Area / component (from repo's existing labels), Needs-triage / needs-info flags",
              },
            ],
          },
        },
      ],
      reply:
        "Done. The **Issue Triage** app is built, installed, and verified — open it at [Issue Triage](/apps/issue-triage).\n\n## What it does\n\nModeled on the existing `code-review` app's architecture (webhook → event-bus routine → action, drizzle DB, dashboard + API, `gh` CLI).\n\n**Labeling (your two asks)**\n1. Candidate labels = **the repo's own GitHub labels** (fetched live) **∪** a **built-in issue-type taxonomy** — the classifier never invents labels outside that union. Area/component labels are drawn *only* from the repo's existing labels; missing built-in `type/*`, `priority/*`, `needs-*` labels are auto-created.\n2. A **dashboard** to add repos and configure each one.\n\n**Four triggers** (all approved): auto on issue *opened*, auto on *edited/reopened* (GitHub webhook, PRs ignored), manual **batch-triage** of open issues, and manual **single-issue** triage by URL/number.\n\n**Classifier** (`issue-classifier` agent, structured output): exactly one Type + one Priority, area labels from existing repo labels, and `needs-info` / `needs-triage` flags — honoring per-repo enabled dimensions and custom rules. Labels are **applied directly**; reasoning is stored for the dashboard.\n\n## Architecture\n\n```mermaid\nflowchart LR\n  GH[GitHub issues webhook] -->|connector_github_subscribe| Bus[Rome event bus]\n  Bus -->|routine| WH[issue-webhook]\n  WH -->|per-repo filter, detached| W[triage-issue worker]\n  Dash[Dashboard] -->|manual / batch| W\n  W --> C[classifier agent]\n  W -->|gh api: create + apply labels| GH2[GitHub issue]\n  W --> DB[(triage_results)]\n```\n\n## Verification\n- `tsc --noEmit` clean, `rome build` passes, active bundle symlinked, API + web both 200.\n- **Real end-to-end proof**: on a throwaway repo an issue was classified `type/bug` + `priority/critical` + `area/api`, missing labels were created, and all landed live on GitHub. A clean-context verifier caught and fixed one routing bug before sign-off.\n",
    },
  ],
};
