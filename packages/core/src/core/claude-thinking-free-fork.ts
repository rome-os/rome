// Thinking-free source transcripts for isolated Claude forks. An isolated fork
// opens with a different tool list than its source, and a model that checks
// thinking-block prefixes (Claude Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1)
// rejects a replayed block whose prefix changed:
// https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
import { randomUUID } from "node:crypto";
import { rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { importSessionToStore, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);
// Fields that name another entry of the same transcript by uuid.
const CHAIN_LINK_FIELDS = ["parentUuid", "logicalParentUuid", "leafUuid"] as const;

export interface StrippedTranscript {
  entries: SessionStoreEntry[];
  /** The checkpoint, moved to its nearest kept ancestor when its entry was dropped. */
  checkpoint?: string;
  strippedBlockCount: number;
}

/**
 * Removes every thinking and redacted_thinking block from the transcript's
 * assistant entries. An entry left with no content is dropped, and every link
 * to it is moved to its nearest kept ancestor, so the parentUuid chain stays
 * whole. Returns new entries and never mutates the input.
 */
export function stripThinkingEntries(
  entries: readonly SessionStoreEntry[],
  checkpoint?: string,
): StrippedTranscript {
  const droppedParent = new Map<string, string | null>();
  const kept: SessionStoreEntry[] = [];
  let strippedBlockCount = 0;

  for (const entry of entries) {
    const content = readAssistantContent(entry);
    if (!content) {
      kept.push(entry);
      continue;
    }
    const remaining = content.filter((block) => !isThinkingBlock(block));
    strippedBlockCount += content.length - remaining.length;
    if (remaining.length === content.length) {
      kept.push(entry);
    } else if (remaining.length > 0) {
      const message = entry.message as Record<string, unknown>;
      kept.push({ ...entry, message: { ...message, content: remaining } });
    } else if (typeof entry.uuid === "string") {
      droppedParent.set(entry.uuid, readUuid(entry.parentUuid));
    }
  }

  const keptAncestor = (uuid: string | null): string | null => {
    let current = uuid;
    while (current !== null && droppedParent.has(current)) {
      current = droppedParent.get(current) ?? null;
    }
    return current;
  };

  const relinked = kept.map((entry) => {
    let next = entry;
    for (const field of CHAIN_LINK_FIELDS) {
      const target = entry[field];
      if (typeof target === "string" && droppedParent.has(target)) {
        next = { ...next, [field]: keptAncestor(target) };
      }
    }
    return next;
  });

  return {
    entries: relinked,
    checkpoint: checkpoint === undefined ? undefined : (keptAncestor(checkpoint) ?? undefined),
    strippedBlockCount,
  };
}

export interface ThinkingFreeTranscript {
  /** Session id to pass as the fork's `resume`. */
  sessionId: string;
  /** The fork's `resumeSessionAt`, moved off any dropped entry. */
  resumeSessionAt?: string;
  strippedBlockCount: number;
  /**
   * Deletes the copy. Idempotent. Claude Code reads the copy only when the
   * fork resumes, so this is safe to call any time after the fork's query opens.
   */
  dispose(): Promise<void>;
}

export interface WriteThinkingFreeTranscriptParams {
  sourceSessionId: string;
  /** Working directory the source session ran in. */
  cwd: string;
  /** The CLAUDE_CONFIG_DIR the fork's Claude Code process runs with. */
  configDir?: string;
  checkpoint?: string;
}

/**
 * Writes a copy of the source session's transcript with every thinking block
 * removed, next to the source in the same projects directory, under a fresh
 * session id. Returns undefined, writing nothing, when the transcript holds no
 * thinking block. Throws when the source transcript cannot be read from
 * `configDir`, so the caller can fall back to resuming the source itself.
 */
export async function writeThinkingFreeTranscript(
  params: WriteThinkingFreeTranscriptParams,
): Promise<ThinkingFreeTranscript | undefined> {
  const configDir = params.configDir ?? join(homedir(), ".claude");
  let projectKey: string | undefined;
  const entries: SessionStoreEntry[] = [];
  // importSessionToStore is the SDK's public reader for local transcripts. Its
  // store key names the transcript's projects directory, which is the same
  // `projects/<projectKey>/<sessionId>.jsonl` layout the SDK writes when it
  // materializes a SessionStore for resume.
  await importSessionToStore(
    params.sourceSessionId,
    {
      append: async (key, batch) => {
        if (key.subpath !== undefined) return;
        projectKey = key.projectKey;
        entries.push(...batch);
      },
      load: async () => null,
    },
    { dir: params.cwd, includeSubagents: false },
  );
  if (!projectKey) {
    throw new Error(`Claude transcript ${params.sourceSessionId} has no entries`);
  }

  const projectDir = join(configDir, "projects", projectKey);
  // The SDK reads from process.env's CLAUDE_CONFIG_DIR, which can differ from
  // the fork's. Write only beside a source the fork's process can also see.
  await stat(join(projectDir, `${params.sourceSessionId}.jsonl`));

  const stripped = stripThinkingEntries(entries, params.checkpoint);
  if (stripped.strippedBlockCount === 0) return undefined;

  const sessionId = randomUUID();
  const path = join(projectDir, `${sessionId}.jsonl`);
  const lines = stripped.entries.map((entry) =>
    JSON.stringify("sessionId" in entry ? { ...entry, sessionId } : entry),
  );
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });

  return {
    sessionId,
    resumeSessionAt: stripped.checkpoint,
    strippedBlockCount: stripped.strippedBlockCount,
    dispose: () => rm(path, { force: true }),
  };
}

function readAssistantContent(entry: SessionStoreEntry): unknown[] | undefined {
  if (entry.type !== "assistant") return undefined;
  const message = entry.message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : undefined;
}

function isThinkingBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    THINKING_BLOCK_TYPES.has((block as { type?: unknown }).type as string)
  );
}

function readUuid(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
