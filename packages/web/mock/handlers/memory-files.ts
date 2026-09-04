import { dir, file, fileBrowserHandlers, type MockFsNode } from "./file-browser";

/**
 * The memory dir the Memory page browses — the fixture counterpart of the tree
 * core seeds from `packages/core/memory.example`, filled in as if Rome had been
 * running for a while against the People fixtures.
 *
 * The relationship profiles are the reason this exists: a person's dossier
 * links to `memory/relationship/<person-id>.md`, and that link led nowhere in
 * mock mode until this tree served it. `memoryProfilePath` below is what keeps
 * the two surfaces from disagreeing about who has a profile.
 */

/**
 * Today's journal entry, dated off the browser's clock like the People
 * fixtures' relative timestamps — a literal date would read as months stale
 * within a release.
 */
const now = new Date();
const year = String(now.getFullYear());
const month = String(now.getMonth() + 1).padStart(2, "0");
const day = String(now.getDate()).padStart(2, "0");

const journalEntry = file(
  `memory/journal/${year}/${month}/${day}.md`,
  `# ${year}-${month}-${day}\n\n` +
    "- Ray asked about the Saturday hike again. Held off on committing — the weather call is Friday.\n" +
    "- Mira sent the clinic's intake form. Filed under topics/health.md.\n" +
    "- Nadia changed numbers. Nothing written down until the guardian confirms it.\n",
);

export const memoryTree: MockFsNode[] = [
  dir("memory/journal", [
    dir(`memory/journal/${year}`, [dir(`memory/journal/${year}/${month}`, [journalEntry])]),
  ]),
  dir("memory/projects", [
    dir("memory/projects/default", [
      file(
        "memory/projects/default/PROJECT.md",
        "# Default\n\n" +
          "The catch-all project. Anything without a home lands here until it earns one.\n\n" +
          "## Status\n\nNothing in flight.\n",
      ),
    ]),
  ]),
  dir("memory/relationship", [
    file(
      "memory/relationship/BONDS.md",
      "# Relationship Bonds\n\n" +
        "Tier definitions live in the seeded template; this copy carries the roster.\n\n" +
        "## Inner Circle\n\n" +
        "- [ray-oster](ray-oster.md) — climbing partner, ten years\n" +
        "- [nadia-petrova](nadia-petrova.md) — sister-in-law\n\n" +
        "## Acquaintance\n\n" +
        "- [mira-chen](mira-chen.md) — neighbour, runs the building's group chat\n\n" +
        "## Other\n\n" +
        "<!-- Nobody yet. -->\n",
    ),
    file(
      "memory/relationship/GUARDIAN.md",
      "# Guardian Profile\n\n" +
        "**Name:** Mock Guardian\n\n" +
        "**Timezone:** America/Los_Angeles\n\n" +
        "## Communication Preferences\n\n" +
        "- Short replies. Five lines is the ceiling for a summary.\n" +
        "- No messages before 09:00 local unless something is on fire.\n\n" +
        "## Important Dates\n\n" +
        "- Birthday: March 4\n",
    ),
    file(
      "memory/relationship/mira-chen.md",
      "# Mira Chen\n\n" +
        "## Overview\n\n" +
        "| Field           | Value                                  |\n" +
        "|-----------------|----------------------------------------|\n" +
        "| **Name**        | Mira Chen                              |\n" +
        "| **Known Since** | 2025-11                                |\n" +
        "| **Bond Level**  | Acquaintance                           |\n" +
        "| **Relation**    | Neighbour, two floors up               |\n\n" +
        "## Channel Mappings\n\n" +
        "| Channel  | ID / Handle    |\n" +
        "|----------|----------------|\n" +
        "| WhatsApp | +1 415 555 0188 |\n\n" +
        "## Notes\n\n" +
        "Runs the building's group chat. Messages in bursts and expects a same-day reply.\n\n" +
        "## Interaction History\n\n" +
        "- Sent the clinic intake form, unprompted.\n" +
        "- Asked twice about the package left in the lobby.\n",
    ),
    file(
      "memory/relationship/nadia-petrova.md",
      "# Nadia Petrova\n\n" +
        "## Overview\n\n" +
        "| Field           | Value                        |\n" +
        "|-----------------|------------------------------|\n" +
        "| **Name**        | Nadia Petrova                |\n" +
        "| **Known Since** | 2019                         |\n" +
        "| **Bond Level**  | Inner Circle                 |\n" +
        "| **Relation**    | Sister-in-law                |\n\n" +
        "## Channel Mappings\n\n" +
        "None. Everything with Nadia happens off Rome, so nothing here is\n" +
        "reachable — the profile is the only record.\n\n" +
        "## Important Dates\n\n" +
        "- Birthday: September 21\n\n" +
        "## Notes\n\n" +
        "Changed numbers recently. Ask the guardian before writing the new one down.\n",
    ),
    file(
      "memory/relationship/ray-oster.md",
      "# Ray Oster\n\n" +
        "## Overview\n\n" +
        "| Field           | Value                          |\n" +
        "|-----------------|--------------------------------|\n" +
        "| **Name**        | Ray Oster                      |\n" +
        "| **Known Since** | 2016                           |\n" +
        "| **Bond Level**  | Inner Circle                   |\n" +
        "| **Relation**    | Climbing partner, ten years    |\n\n" +
        "## Channel Mappings\n\n" +
        "| Channel  | ID / Handle     |\n" +
        "|----------|-----------------|\n" +
        "| Telegram | 418820113       |\n" +
        "| WhatsApp | +1 415 555 0142 |\n\n" +
        "## Preferences\n\n" +
        "- Goes by Ray, never Raymond.\n" +
        "- Plans by voice note; a written plan gets read late.\n\n" +
        "## Important Dates\n\n" +
        "- Birthday: June 12\n\n" +
        "## Notes\n\n" +
        "Proposes a Saturday hike most weeks and cancels about half of them.\n" +
        "Weather is the deciding factor, and the call comes Friday evening.\n\n" +
        "## Interaction History\n\n" +
        "- Asked about the Saturday hike, again.\n" +
        "- Sent photos from the Tahoe trip.\n",
    ),
  ]),
  dir("memory/topics", [
    file(
      "memory/topics/health.md",
      "# Health\n\n" +
        "## Providers\n\n" +
        "- Primary care: Bay Ridge Clinic. Intake form on file since this week.\n\n" +
        "## Notes\n\n" +
        "Nothing ongoing. This file exists so the routing rule in MEMORY.md has\n" +
        "somewhere real to point.\n",
    ),
  ]),
  file(
    "memory/IDENTITY.md",
    "# Identity\n\n**Agent Name:** Rome\n\n" +
      "Answers to Rome. Writes the way the guardian asked for: short, plain, no\n" +
      "throat-clearing.\n",
  ),
  file(
    "memory/MEMORY.md",
    "# Memory\n\n" +
      "The always-on index. Frequently-used facts live here inline; everything\n" +
      "else is a one-line pointer to the file that owns it.\n\n" +
      "## Topics\n\n" +
      "- [Health](topics/health.md) — providers, intake paperwork\n\n" +
      "## Key Facts\n\n" +
      "- Lives in San Francisco, works from home Tuesdays and Thursdays.\n" +
      "- Climbs with [Ray](relationship/ray-oster.md) most Saturdays.\n\n" +
      "## Preferences\n\n" +
      "- Concise replies. Summaries stay under five lines.\n" +
      "- Nothing before 09:00 local.\n\n" +
      "## Top of Mind\n\n" +
      "- Whether Saturday's hike is on. The call comes Friday evening.\n",
  ),
];

/**
 * Where a person's profile lives, or null when nothing has been written about
 * them — the fixture stand-in for the relationship-dir read core answers
 * `memoryPath` from. Reading it off the tree is what keeps the dossier's
 * "Memory profile" link from pointing at a file the browser cannot open.
 */
export function memoryProfilePath(personId: string): string | null {
  const path = `memory/relationship/${personId}.md`;
  const relationships = memoryTree.find((node) => node.path === "memory/relationship");
  return relationships?.children?.some((node) => node.path === path) ? path : null;
}

export const memoryFileHandlers = fileBrowserHandlers({
  apiBasePath: "/api/memory",
  logicalRoot: "memory",
  tree: memoryTree,
});
