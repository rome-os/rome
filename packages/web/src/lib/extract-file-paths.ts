// File-following / projects-panel navigation derives its target paths from a
// single source: the file links the agent puts in its own message ("the
// agent's overall result"). Nothing in the trace's intermediate tool activity
// — neither `tool_use` inputs nor `tool_result` outputs — drives navigation,
// because both surface files the agent merely *touched* (read, listed, grepped,
// or whose path happened to appear in command output) rather than ones it
// deliberately produced and presented. Those were the source of the false
// triggers (e.g. an image opening just because a mid-turn `ls` named it).

// Matches markdown links the assistant emits to point at project files,
// e.g. `[label](</projects/default/screenshots/foo.png>)`. The URL is
// required to be wrapped in `< >` and rooted at `/projects/`.
const PROJECTS_MD_LINK_RE = /\[[^\]]*\]\(<(\/projects\/[^>]+)>\)/g;

export function extractFilePathsFromText(content: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  PROJECTS_MD_LINK_RE.lastIndex = 0;
  let match;
  while ((match = PROJECTS_MD_LINK_RE.exec(content)) !== null) {
    const p = match[1];
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}
