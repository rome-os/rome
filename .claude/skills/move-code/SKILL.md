---
name: move-code
description: Move or rename TypeScript files, folders, or top-level declarations and leave every reference to them correct. Use when a change moves or renames source files, moves a function, type, class or const from one file to another, or renames one, such as gathering code into a context folder.
---

# Move code

Run every move through `pnpm move-files <from>:<to> ...` ([`scripts/move-files.ts`](../../../scripts/move-files.ts)), never through `git mv` and hand edits. Give all the moves of one change in one call, and list only the source files: their tests follow them. The tool rewrites imports, mock paths, Markdown links, and paths in docs and comments that name a moved file, then formats what it touched.

Move a top-level declaration between files with `pnpm move-symbol <from> <to> <name> ...`, and rename one with `pnpm rename-symbol <file> <old> <new>`, never by hand. Both drive TypeScript's own refactors ([`scripts/ts-service.ts`](../../../scripts/ts-service.ts)), so they reach the files the package's tsconfig includes. Clear unused imports with Biome: `biome lint --only=correctness/noUnusedImports --write --unsafe <paths>`.

You own what `move-files` lists at the end: lines that still name an old path, which are paths built by hand in code, configs and bundler inputs. Fix each one or confirm it names something else. A path assembled from folder names, such as `join(dir, "actions")`, is not listed, so search for the old folder names yourself.

The move is done when `pnpm typecheck` and `pnpm lint:imports` pass (a rename that clashes with an existing name shows up only there), the tests of every moved file pass, and git shows each moved file as a rename whose only edits are paths. When the tool rewrites a reference wrongly, or misses one it could find mechanically, fix the tool as well as the output.
