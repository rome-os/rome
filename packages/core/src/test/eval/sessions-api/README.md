# Sessions API eval

Scores whether the Sessions API is clear and respected: the session module keeps
out of its callers' business, and callers reach it only through its entry
points. Every check reads the source tree of the checkout it scores, so this
eval lives on its own branch, `eval/sessions-api`, and scores any other.

```
packages/core/src/test/eval/sessions-api/run.sh --tree /path/to/checkout
packages/core/src/test/eval/sessions-api/run.sh --tree /path/to/checkout --parity
```

Without `--tree` it scores the checkout it runs in. `--parity` also runs the
type check and the core unit tests of the scored tree and compares them with
`baseline.json`; `--parity --baseline` records the scored tree as the baseline.
Results go to `out/scorecard.md`, and one line per run to `out/history.jsonl`.

Changes to the checks merge straight into this branch. The checks and what each
measures are in `scorecard.ts`, one block per check, C1 upwards.
