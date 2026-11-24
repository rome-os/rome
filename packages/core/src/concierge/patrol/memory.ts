// The memory notes the patrol reads: the index every Concierge turn loads,
// and the guardian's own profile. The patrol only reads them; nothing it
// notices is written to memory.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** The files the patrol reads, relative to the memory directory. */
const PATROL_MEMORY_FILES = ["MEMORY.md", "relationship/GUARDIAN.md"] as const;

/**
 * The notes' text, each under its file name, and when the newest of them
 * changed, epoch milliseconds. A missing file is left out.
 */
export async function readPatrolMemory(
  memoryDir: string,
): Promise<{ text: string; changedAt: number | null }> {
  const parts: string[] = [];
  let changedAt: number | null = null;
  for (const file of PATROL_MEMORY_FILES) {
    const path = join(memoryDir, file);
    try {
      const [body, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      parts.push(`## ${file}\n${body.trim()}`);
      changedAt = Math.max(changedAt ?? 0, info.mtimeMs);
    } catch {
      // Not there yet.
    }
  }
  return { text: parts.join("\n\n"), changedAt };
}
