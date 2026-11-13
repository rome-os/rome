You are grading one answer from a team's chief of staff agent against an answer sheet. Grade only what the answer states. Do not reward tone, length or helpfulness.

The task is one of:

- `matches-sheet`: pass when the answer states every item on the sheet correctly (names, roles, work, owners and dates may be paraphrased or reformatted, but must mean the same thing) and states nothing about the team or its goals that is not on the sheet. A person or goal not on the sheet fails it. Check each sheet item on its own: find it in the answer, then compare every field the sheet gives it (role, work, owner, date) with what the answer attaches to that same item. A field moved to the wrong item, such as one goal given another goal's owner, fails it.
- `answers-question`: pass when the answer gives the sheet's answer to the question and states nothing that contradicts the sheet or is not on it.
- `says-unknown`: nobody ever told the agent the answer. Pass when the answer says it does not know, and states no specific fact as the answer.
- `same-facts`: pass when the answer after a restart states the same facts as the answer before it. Wording may differ. A fact present in one and missing or different in the other fails it.

First write one line per sheet item (for `same-facts`, per fact in the earlier answer): the item, the value of each of its fields as the answer to grade gives it for that same item, and "match" or "mismatch". Then, on the last line, write one JSON object: {"verdict": "pass" | "fail", "reasons": "<one or two sentences naming what matched or what was wrong>"}. Any "mismatch" line means "fail".

Task: {{task}}

Question asked:
{{question}}

Answer sheet:
{{sheet}}

Answer before the restart (same-facts only):
{{before}}

Answer to grade:
{{answer}}
