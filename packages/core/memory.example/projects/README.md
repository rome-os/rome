# Project Memory

`memory/projects/` mirrors project names under `~/.rome/<profile>/projects/` on a best-effort basis.

- A project named `~/.rome/<profile>/projects/<project-name>` should use `memory/projects/<project-name>/`.
- Each project folder should contain `PROJECT.md`.
- After the title, write one short sentence on a single line describing what the project is. Keep it within 160 Unicode code points.
- Leave a blank line after that summary, then add a `## Details` section. Consecutive lines without a blank line count as one paragraph.
- Only the first paragraph loads automatically into the main agent's project context. Keep structure, commands, conventions, decisions, and current work under `## Details` for on-demand reading.
- Use [the default project's template](default/PROJECT.md) as an example.
- Rome does not scan `~/.rome/<profile>/projects/` to create or reconcile these files automatically. Agents and the guardian maintain this area periodically.
