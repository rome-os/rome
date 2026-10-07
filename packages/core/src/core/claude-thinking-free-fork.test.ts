import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { stripThinkingEntries, writeThinkingFreeTranscript } from "./claude-thinking-free-fork.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

function user(uuid: string, parentUuid: string | null, text: string): SessionStoreEntry {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: SOURCE_ID,
    message: { role: "user", content: text },
  };
}

function assistant(
  uuid: string,
  parentUuid: string | null,
  content: Record<string, unknown>[],
): SessionStoreEntry {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: SOURCE_ID,
    message: { id: "msg", role: "assistant", content },
  };
}

const thinking = { type: "thinking", thinking: "", signature: "sig" };
const redacted = { type: "redacted_thinking", data: "opaque" };
const text = (value: string) => ({ type: "text", text: value });

// Claude Code writes one transcript entry per content block, so a turn's
// thinking blocks are entries of their own in the parentUuid chain.
const transcript: SessionStoreEntry[] = [
  user("u1", null, "hi"),
  assistant("t1", "u1", [thinking]),
  assistant("t2", "t1", [redacted]),
  assistant("a1", "t2", [text("hello")]),
  user("u2", "a1", "again"),
  assistant("t3", "u2", [thinking]),
  { type: "last-prompt", leafUuid: "t3" },
];

describe("stripThinkingEntries", () => {
  it("drops thinking entries and links each child to its nearest kept ancestor", () => {
    const result = stripThinkingEntries(transcript);

    expect(result.strippedBlockCount).toBe(3);
    expect(result.entries.map((entry) => [entry.uuid, entry.parentUuid])).toEqual([
      ["u1", null],
      ["a1", "u1"],
      ["u2", "a1"],
      [undefined, undefined],
    ]);
    expect(result.entries.at(-1)).toEqual({ type: "last-prompt", leafUuid: "u2" });
  });

  it("removes thinking blocks from an entry that also holds other blocks", () => {
    const result = stripThinkingEntries([
      user("u1", null, "hi"),
      assistant("a1", "u1", [thinking, text("hello")]),
    ]);

    expect(result.strippedBlockCount).toBe(1);
    expect(result.entries[1]).toMatchObject({
      uuid: "a1",
      parentUuid: "u1",
      message: { content: [text("hello")] },
    });
  });

  it("moves a checkpoint on a dropped entry to its nearest kept ancestor", () => {
    expect(stripThinkingEntries(transcript, "t3").checkpoint).toBe("u2");
    expect(stripThinkingEntries(transcript, "a1").checkpoint).toBe("a1");
  });

  it("returns the entries unchanged when none holds a thinking block", () => {
    const plain = [user("u1", null, "hi"), assistant("a1", "u1", [text("hello")])];
    const result = stripThinkingEntries(plain);

    expect(result.strippedBlockCount).toBe(0);
    expect(result.entries).toEqual(plain);
  });

  it("does not mutate the input", () => {
    const input = structuredClone(transcript);
    stripThinkingEntries(input, "t3");
    expect(input).toEqual(transcript);
  });
});

describe("writeThinkingFreeTranscript", () => {
  let configDir: string;
  let cwd: string;
  let projectDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "rome-claude-config-"));
    cwd = await realpath(await mkdtemp(join(tmpdir(), "rome-claude-cwd-")));
    // Claude Code names a project's directory after its cwd, with every
    // character outside [a-zA-Z0-9] replaced by "-".
    projectDir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(projectDir, { recursive: true });
    // importSessionToStore reads transcripts from process.env's config dir.
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  async function writeSource(entries: SessionStoreEntry[]) {
    const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(join(projectDir, `${SOURCE_ID}.jsonl`), `${lines}\n`);
  }

  async function readCopy(sessionId: string): Promise<SessionStoreEntry[]> {
    const raw = await readFile(join(projectDir, `${sessionId}.jsonl`), "utf8");
    return raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionStoreEntry);
  }

  it("writes a thinking-free copy beside the source under a fresh session id", async () => {
    await writeSource(transcript);

    const copy = await writeThinkingFreeTranscript({
      sourceSessionId: SOURCE_ID,
      cwd,
      configDir,
      checkpoint: "t3",
    });

    expect(copy).toMatchObject({ resumeSessionAt: "u2", strippedBlockCount: 3 });
    expect(copy!.sessionId).not.toBe(SOURCE_ID);
    const entries = await readCopy(copy!.sessionId);
    expect(JSON.stringify(entries)).not.toContain("thinking");
    expect(entries.map((entry) => entry.uuid).filter(Boolean)).toEqual(["u1", "a1", "u2"]);
    expect(
      new Set(entries.filter((entry) => "sessionId" in entry).map((entry) => entry.sessionId)),
    ).toEqual(new Set([copy!.sessionId]));

    await copy!.dispose();
    await copy!.dispose();
    expect(await readdir(projectDir)).toEqual([`${SOURCE_ID}.jsonl`]);
  });

  it("writes nothing when the source holds no thinking block", async () => {
    await writeSource([user("u1", null, "hi"), assistant("a1", "u1", [text("hello")])]);

    await expect(
      writeThinkingFreeTranscript({ sourceSessionId: SOURCE_ID, cwd, configDir }),
    ).resolves.toBeUndefined();
    expect(await readdir(projectDir)).toEqual([`${SOURCE_ID}.jsonl`]);
  });

  it("throws when the source transcript does not exist", async () => {
    await expect(
      writeThinkingFreeTranscript({ sourceSessionId: SOURCE_ID, cwd, configDir }),
    ).rejects.toThrow();
  });

  it("throws when the fork's config dir does not hold the source", async () => {
    await writeSource(transcript);
    const otherConfigDir = await mkdtemp(join(tmpdir(), "rome-claude-config-"));

    await expect(
      writeThinkingFreeTranscript({
        sourceSessionId: SOURCE_ID,
        cwd,
        configDir: otherConfigDir,
      }),
    ).rejects.toThrow();
    await rm(otherConfigDir, { recursive: true, force: true });
  });
});
