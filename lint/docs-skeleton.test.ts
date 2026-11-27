import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { docsSkeletonGaps, judge } from "./docs-skeleton.js";

let repo: string;

async function write(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), text);
}

const PART = "packages/core/src/connections/AGENTS.md";
const CONCEPT = "docs/target/concepts/connected-account.md";

const partDoc = [
  "# packages/core/src/connections/",
  "",
  "**Question.** What access does Rome have to which outside account?",
  "",
  "**Promises.**",
  "",
  "1. It delivers a chat's messages in order.",
  "",
  "**May use.** Nothing.",
  "",
  "## Playbook",
].join("\n");

const conceptDoc = [
  "# Connected account",
  "",
  "**Purpose.** Rome acts through one outside account.",
  "",
  "**Story.** If the guardian connects an account, Rome can send as that account.",
  "",
  "**Carried by.** [Connections](../../../packages/core/src/connections/AGENTS.md)",
].join("\n");

/** A skeleton with one part and one concept, and nothing missing. */
async function writeSkeleton(): Promise<void> {
  await write("docs/target/purpose.md", "# Purpose\n\nRome is an agent a team shares.\n");
  await write("docs/target/never.md", "# Never\n\n- An upgrade loses chats.\n");
  await write("docs/target/together.md", "# Together\n\n- A message starts a turn.\n");
  await write("docs/target/parts.md", `# Parts\n\n- [Connections](../../${PART})\n`);
  await write(PART, partDoc);
  await write(CONCEPT, conceptDoc);
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "docs-skeleton-lint-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("docsSkeletonGaps", () => {
  it("finds no gap in a skeleton with one part and one concept", async () => {
    await writeSkeleton();

    expect(docsSkeletonGaps(repo)).toEqual([]);
  });

  it("lists every piece of the skeleton in a repo that has none", () => {
    expect(docsSkeletonGaps(repo)).toEqual([
      "docs/target/purpose.md: missing",
      "docs/target/never.md: missing",
      "docs/target/together.md: missing",
      "docs/target/parts.md: missing",
      "docs/target/concepts: no concept",
    ]);
  });

  it("reports a doc for the whole product that holds only its title", async () => {
    await writeSkeleton();
    await write("docs/target/never.md", "# Never\n");

    expect(docsSkeletonGaps(repo)).toEqual(["docs/target/never.md: empty"]);
  });

  it("reports a doc for the whole product that holds only its title and a comment", async () => {
    await writeSkeleton();
    await write("docs/target/together.md", "# Together\n\n<!-- TODO: write\nthis -->\n");

    expect(docsSkeletonGaps(repo)).toEqual(["docs/target/together.md: empty"]);
  });

  it("reports a listed part that has no link, and one whose AGENTS.md does not exist", async () => {
    await writeSkeleton();
    await write(
      "docs/target/parts.md",
      `- [Connections](../../${PART})\n- Chats\n- [Agents](../../packages/core/src/agent/AGENTS.md)\n`,
    );

    expect(docsSkeletonGaps(repo)).toEqual([
      'docs/target/parts.md: part "Chats" has no link to its AGENTS.md',
      "packages/core/src/agent/AGENTS.md: missing",
    ]);
  });

  it("reports each field a part's AGENTS.md lacks, and promises that are not numbered", async () => {
    await writeSkeleton();
    await write(
      PART,
      "# connections\n\n**Promises.** It delivers messages in order.\n\n**May use.**\n",
    );

    expect(docsSkeletonGaps(repo)).toEqual([
      `${PART}: no "Question"`,
      `${PART}: no "May use"`,
      `${PART}: "Promises" has no numbered promise`,
    ]);
  });

  it("reports each field a concept lacks", async () => {
    await writeSkeleton();
    await write(
      CONCEPT,
      "# Connected account\n\n**Purpose.** Rome acts through one outside account.\n",
    );

    expect(docsSkeletonGaps(repo)).toEqual([
      `${CONCEPT}: no "Story"`,
      `${CONCEPT}: no "Carried by"`,
    ]);
  });

  it("reports a concept carried by a part that the parts list does not name", async () => {
    await writeSkeleton();
    await write(CONCEPT, conceptDoc.replace("connections/AGENTS.md", "chats/AGENTS.md"));

    expect(docsSkeletonGaps(repo)).toEqual([
      `${CONCEPT}: "Carried by" links to no part of docs/target/parts.md`,
    ]);
  });

  it("does not count a field that only appears in a code example", async () => {
    await writeSkeleton();
    await write(CONCEPT, conceptDoc.replace("**Story.**", "```\n**Story.** An example.\n```\n"));

    expect(docsSkeletonGaps(repo)).toEqual([`${CONCEPT}: no "Story"`]);
  });

  it("does not count a field inside a tilde block, or inside a block that a shorter fence cannot close", async () => {
    await writeSkeleton();
    await write(
      CONCEPT,
      conceptDoc
        .replace("**Purpose.**", "~~~\n**Purpose.** An example.\n~~~\n")
        .replace("**Story.**", "````\n```\n**Story.** An example.\n```\n````\n"),
    );

    expect(docsSkeletonGaps(repo)).toEqual([`${CONCEPT}: no "Purpose"`, `${CONCEPT}: no "Story"`]);
  });

  it("reads an indented item of the parts list as a note, not as a part", async () => {
    await writeSkeleton();
    await write("docs/target/parts.md", `- [Connections](../../${PART})\n  - owns accounts\n`);

    expect(docsSkeletonGaps(repo)).toEqual([]);
  });

  it("reads a link that opens with a slash from the repo root", async () => {
    await writeSkeleton();
    await write("docs/target/parts.md", `- [Connections](/${PART})\n`);

    expect(docsSkeletonGaps(repo)).toEqual([]);
  });
});

describe("judge", () => {
  it("passes when the gaps found are exactly the known ones", () => {
    expect(judge(["a: missing"], ["a: missing"])).toEqual({ fresh: [], closed: [] });
  });

  it("fails on a gap that is not listed, and on a listed gap that is closed", () => {
    expect(judge(["b: missing"], ["a: missing"])).toEqual({
      fresh: ["b: missing"],
      closed: ["a: missing"],
    });
  });
});
