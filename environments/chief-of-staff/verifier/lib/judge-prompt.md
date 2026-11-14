You are grading one answer from a team's chief of staff agent against an answer sheet. Grade only what the answer states. Do not reward tone, length or helpfulness.

The task is one of:

- `matches-sheet`: pass when the answer states every item on the sheet correctly (names, roles, work, owners and dates may be paraphrased or reformatted, but must mean the same thing) and states nothing about the team or its goals that is not on the sheet. A person or goal not on the sheet fails it. Check each sheet item on its own: find it in the answer, then compare every field the sheet gives it (role, work, owner, date) with what the answer attaches to that same item. A field moved to the wrong item, such as one goal given another goal's owner, fails it. A goal the answer names as dropped, not current, is not a goal stated as current and does not fail it; a dropped goal listed among the current goals fails it.
- `answers-question`: pass when the answer gives the sheet's answer to the question, and every other fact it states is in the team's documents below. Naming where a fact came from, such as "the team roster" or a link, is a source, not a fact. A fact that contradicts the sheet or the team's documents, or appears in neither, fails it.
- `says-unknown`: nobody ever told the agent the answer. Pass when the answer says it does not know, and states no specific fact as the answer.
- `same-facts`: compare only the facts on the answer sheet: its people, roles and current work, or its goals, owners and dates. Pass when every sheet item that the answer before the restart states is stated the same way, with the same fields, in the answer after it. Wording may differ. A sheet item present in one and missing or different in the other fails it. Ignore every fact not on the sheet, in either answer, such as goals added to an answer about the team, or a note about a dropped goal.

First write one line per sheet item (for `answers-question`, per fact the answer states, saying where it is found: the sheet, the team's documents, or neither; for `same-facts`, per sheet item, with its fields in each answer): the item, the value of each of its fields as the answer to grade gives it for that same item, and "match" or "mismatch" (for `answers-question`, "neither" is a mismatch). Then, on the last line, write one JSON object: {"verdict": "pass" | "fail", "reasons": "<one or two sentences naming what matched or what was wrong>"}. Any "mismatch" line means "fail".

Task: {{task}}

Question asked:
{{question}}

Answer sheet:
{{sheet}}

The team's documents (answers-question only):
{{documents}}

Answer before the restart (same-facts only):
{{before}}

Answer to grade:
{{answer}}
