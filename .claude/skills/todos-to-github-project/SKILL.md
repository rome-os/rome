---
name: todos-to-github-project
description: Turn the remaining todos of the current conversation into a GitHub project of task-spec issues wired with native blocked-by dependencies.
disable-model-invocation: true
---

# Todos to GitHub project

Goal end-state: every remaining todo of the conversation is one task-spec issue, the issues sit in one GitHub project, every dependency is a blocked-by edge on GitHub, and each in-scope issue carries `ready-for-agent`.

The issue format — title, body sections, the `ready-for-agent` bar — is defined in [docs/authoring/github-issues.md](../../../docs/authoring/github-issues.md) and [docs/authoring/github-issues-task-spec.md](../../../docs/authoring/github-issues-task-spec.md). Prose in titles and bodies follows [docs/authoring/WRITING.md](../../../docs/authoring/WRITING.md). This skill covers what to file, in which order, and with which `gh` calls.

## 1. Harvest

1. Collect every remaining todo from the conversation: open task-list items, deferred follow-ups, and work the user parked for later.
2. Search the tracker for each todo with `gh issue list --search "<keywords>"`. If an existing issue already tracks it, drop the todo from the set.
3. Write one sentence per todo stating the outcome its issue must deliver. If the sentence only makes sense with the conversation open, ask the user what the todo means.

## 2. Draft

1. Name the project after the outcome the set delivers, not after the conversation.
2. Split the todos into in-scope and out-of-scope. An out-of-scope todo files as a plain issue, stays out of the project, and carries no label.
3. Draft each in-scope issue as a task spec in the github-issues-task-spec.md format, title included.
4. Wire the dependencies. Issue X is blocked by issue Y when X cannot start before Y merges. Record each edge as a **Blocked by** line in X's body.
5. Check the edge graph for cycles. A cycle is a decomposition error — re-split the todos until the graph is acyclic.
6. Apply the label bar from github-issues-task-spec.md: every in-scope issue gets `task`, and an issue implementable from its body alone also gets `ready-for-agent`. An issue still waiting on a user decision files without `ready-for-agent`.

## 3. Approve

The draft stays out of chat. Ask for the go-ahead in one line — the project title and the issue count — and write nothing to GitHub before the user gives it. Present issue titles or bodies only when the user asks to see them.

## 4. Create

If `gh label list` does not show `ready-for-agent`, create it with `gh label create ready-for-agent`.

1. Resolve the repo and owner: `gh repo view --json nameWithOwner`.
2. Create the project: `gh project create --owner <owner> --title "<title>"`.
3. Link the project to the repo so it shows up under the repo's Projects tab: `gh project link <project-number> --owner <owner> --repo <owner>/<repo>`.
4. Create the issues in dependency order, blockers first, so every **Blocked by** line names a real issue number: `gh issue create --title "<title>" --body "<body>" --label ready-for-agent`.
5. Add each in-scope issue to the project: `gh project item-add <project-number> --owner <owner> --url <issue-url>`.
6. Mirror every edge into GitHub's native relation. The `issue_id` is the blocking issue's numeric REST id (`gh api repos/<owner>/<repo>/issues/<number> --jq .id`), not its issue number:

   ```bash
   gh api -X POST repos/<owner>/<repo>/issues/<blocked-number>/dependencies/blocked_by -F issue_id=<blocking-id>
   ```

## 5. Verify

1. Confirm the link with `gh repo view --json projectsV2`. The new project must appear in the list.
2. List the project items with `gh project item-list <project-number> --owner <owner>`. The count must match the in-scope set.
3. Read back each issue's edges with `gh api repos/<owner>/<repo>/issues/<number>/dependencies/blocked_by`. Every drafted edge must appear.
4. Report the project URL and each issue number with its blockers.
