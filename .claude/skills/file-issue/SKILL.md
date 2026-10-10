---
name: file-issue
description: File one GitHub issue from a description the user gives — classify it as a bug report, feature request, or task spec, gather what the body needs from the tracker and the code, ask the user only for what those cannot answer, draft it in the repo's issue format, and create it with `gh` after a go-ahead. Use when the user says "file an issue / bug / feature request / task for <description>".
argument-hint: [description]
disable-model-invocation: true
---

# File an issue

Goal end-state: one issue on the tracker whose type, title, body sections, and labels follow [docs/authoring/github-issues.md](../../../docs/authoring/github-issues.md) and the rulebook of its type, with every required section filled from evidence.

The description arrives as the skill argument or in the conversation: $ARGUMENTS

The authoring docs own the issue format, and a rule there wins over any wording here. Read the shared rules first, then the rulebook of the type chosen in step 1:

- [github-issues.md](../../../docs/authoring/github-issues.md) — title shape, the Situation section, the type labels.
- [github-issues-bug-report.md](../../../docs/authoring/github-issues-bug-report.md)
- [github-issues-feature-request.md](../../../docs/authoring/github-issues-feature-request.md)
- [github-issues-task-spec.md](../../../docs/authoring/github-issues-task-spec.md)

Prose in the title and body follows [docs/authoring/WRITING.md](../../../docs/authoring/WRITING.md). Situation uses the terms in [docs/concepts/](../../../docs/concepts/index.md), and a term links to its entry on first use with a full `https://github.com/<owner>/<repo>/blob/main/docs/concepts/<file>.md#<anchor>` URL, because a relative link does not resolve inside an issue body.

## 1. Classify

Decide the type with the two questions from github-issues.md, in order:

1. Does the system break its own intended behavior? → **bug report**.
2. Is the change already decided and scoped? → **task spec**.
3. Otherwise → **feature request**. A pain point with no feature attached, and a feature idea, both file as a feature request.

When the description supports two readings that change the type — a symptom the user may or may not consider intended behavior, or a change the user may or may not have decided — ask which one holds. Carry the question into step 3 rather than asking it alone.

## 2. Gather

Fill the required sections of the chosen type from three sources, in this order: the description, the tracker, the code. When step 1 left two readings open, gather what both readings need, so the answer in step 3 picks a draft rather than a second gather.

1. Resolve the repo with `gh repo view --json nameWithOwner`. The concept URLs in Situation need the owner and repo name.
2. Search the tracker with `gh issue list --search "<keywords>" --state all`. If an open issue already tracks the same defect, gap, or change, report it and stop. If a closed one covers it, link it from the body.
3. Read the code and the docs that the description touches. For a bug report, reproduce the symptom when the steps are cheap, and gather the evidence Initial triage and Suspected root cause need. For a feature request, find the PRs, incidents, or threads where the gap bit, because Pain carries evidence. For a task spec, read the files Scope names, and decide for each Acceptance item whether a committed test or a one-time check proves it.
4. For a bug report, pick one of `P0`, `P1`, `P2`, `P3` from the label descriptions in `gh label list`.
5. For a task spec, find the issues it depends on and record them as a **Blocked by** line by number.

Step 3 answers what the code can answer. A question goes to the user only for what the description, the tracker, and the code leave open.

## 3. Ask

Collect every open question from steps 1 and 2 and ask them in one round, with one `AskUserQuestion` call. A question earns a slot when a required section cannot be written without the answer, or when the answer changes the type. Every question offers the readings the evidence supports as options, with the most likely one first.

Questions that earn a slot:

- the type, when step 1 left two readings open.
- what the user expected to happen, when the bug rulebook's Symptom needs it and the description states only what happened.
- who pays the pain and where it bit, when the feature rulebook's Pain has no evidence to point to.
- what stays out, when the task rulebook's Scope has no boundary.
- the priority of a bug, when the evidence supports two labels.

Skip the round when no question earns a slot. Ask a second round only when an answer opens a gap the first round could not foresee.

## 4. Draft

1. Write the title in the shape github-issues.md fixes and in the mood the type's rulebook fixes.
2. Write every required section of the type, in the order its rulebook lists, and only the optional sections the evidence fills. Situation opens the body and names no file, symbol, or line number. Sections after Situation carry the exact strings, paths, and commands.
3. For a feature request, write Possible directions only when the user presents a direction in the description or in an answer, and list only the directions the user presented. Otherwise omit the section. A direction the skill would invent on its own stays out of the issue.
4. Set the labels: the type label, plus exactly one priority label for a bug report, plus `ready-for-agent` for a task spec an agent can implement from the body alone. A feature request never carries `ready-for-agent`.
5. Check the draft against the type's rulebook once more: every required section present, Possible fixes and Possible directions pick nothing, Suspected root cause states its confidence, every Acceptance item names what proves it, Scope names what stays out.

## 5. Approve

Show the full draft — title, labels, body — and ask for the go-ahead in one line. Write nothing to GitHub before the user gives it. Apply the user's edits to the draft and show the changed part again before filing.

## 6. Create

1. If `gh label list` lacks a label the draft carries, stop and report the missing label. The repo's label list is the only source of label descriptions, so the skill creates no label.
2. Create the issue, passing the body through a file so that backticks and quotes survive the shell:

   ```bash
   gh issue create --title "<title>" --body-file <path> --label <type-label> [--label <priority-or-ready-for-agent>]
   ```

## 7. Verify

1. Read the issue back with `gh issue view <number> --json title,labels,body` and confirm the title, every label, and every required section landed.
2. For a task spec with a **Blocked by** line, confirm each number names an open issue with `gh issue view <blocking-number> --json state`.
3. Report the issue URL, its type, and its labels.
