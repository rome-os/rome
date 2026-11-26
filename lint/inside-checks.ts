// Rome asks who may enter once, where someone comes in, and nothing past that
// point asks again (docs/domains/participation.md#entry). This lint finds code
// that still decides by whether someone is the guardian, or by personal data
// and the audience of a chat. It reads source text, so a hit is a line that
// names one of those, with comments left out.
//
// A hit is allowed for good when Access answers who the guardian is, or when
// its file is listed in ALLOWED with the number of such lines and why they stay.
// Every other hit is counted in inside-checks-baseline.ts, which only shrinks:
// a file with more hits than listed fails, and so does one with fewer, until
// its count is lowered.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BASELINE } from "./inside-checks-baseline.js";

/** What a hit decides by, and the words that show it. */
const LOOKS: readonly { by: string; pattern: RegExp }[] = [
  {
    by: "whether someone is the guardian",
    pattern:
      /[!=]==?\s*"guardian"|"guardian"\s*[!=]==?|\bvia\s*[!=]==?\s*"cookie"|\b(is|needs|only)_?[Gg]uardian|guardian_?[Oo]nly|GUARDIAN_ONLY/,
  },
  {
    by: "personal data or the audience",
    pattern:
      /isPersonalDataAction|readsPersonalData|PERSONAL_DATA_(?!SOURCES\b|CATALOG_ACTION\b|QUERY_ACTION\b)\w+|\.personal\b|\b\w*[Aa]udience\b|AUDIENCE|private_only/,
  },
];

const ROOTS = ["packages/core/src", "packages/rome-node-cli/src"];

/** Where Access answers who the guardian is. */
const ACCESS = "packages/core/src/access/";

/** Hits that stay, by file: what the lines do, and how many there are. */
const ALLOWED: Readonly<Record<string, { lines: number; why: string }>> = {
  "packages/core/src/api/routes/vault.ts": {
    lines: 3,
    why: "only the guardian resets the vault, and a shell never types its PIN",
  },
  "packages/core/src/api/routes/account-codes.ts": {
    lines: 3,
    why: "links an account to the guardian's person",
  },
  "packages/core/src/personal-data/routes.ts": {
    lines: 1,
    why: "personal data comes from the guardian's phone",
  },
  "packages/core/src/api/routes/device-connections.ts": {
    lines: 1,
    why: "devices are reported by the guardian's phone",
  },
  "packages/core/src/api/routes/apps.ts": {
    lines: 3,
    why: "who may open an app is the app's own permission",
  },
  "packages/core/src/api/routes/app-websocket-server.ts": {
    lines: 1,
    why: "who may open an app is the app's own permission",
  },
  "packages/core/src/api/routes/auth.ts": { lines: 2, why: "signs in the guardian's seat" },
  "packages/core/src/api/routes/cloud-login.ts": {
    lines: 1,
    why: "the audience of a Rome Cloud token",
  },
  "packages/core/src/api/routes/instance-enroll.ts": {
    lines: 1,
    why: "the audience of a Rome Cloud token",
  },
  "packages/core/src/api/routes/approvals.ts": { lines: 1, why: "names whose approval it is" },
  "packages/core/src/api/routes/chat-senders.ts": { lines: 3, why: "labels who said it" },
  "packages/core/src/api/routes/webchat-reply.ts": { lines: 1, why: "labels who said it" },
  "packages/core/src/app-host/api.ts": {
    lines: 1,
    why: "a shell waits for a busy worker, it is not refused",
  },
  "packages/core/src/app-host/caller-notify.ts": { lines: 1, why: "names whom to notify" },
  "packages/core/src/live-events-server.ts": { lines: 1, why: "names whose chats to stream" },
  "packages/core/src/usage/attribution.ts": { lines: 2, why: "labels usage by who caused it" },
  "packages/core/src/webchat/automated-source.ts": { lines: 1, why: "labels who said it" },
  "packages/core/src/webchat/chats-webchat-repository.ts": {
    lines: 1,
    why: "reads a stored sender back",
  },
  "packages/core/src/webchat/repository.ts": { lines: 2, why: "reads a stored owner back" },
  "packages/core/src/db/repositories/concierge-tasks.ts": {
    lines: 1,
    why: "reads a stored owner back",
  },
  "packages/core/src/concierge/task-schedule.ts": {
    lines: 1,
    why: "a task of the guardian's runs in the guardian's time zone",
  },
  "packages/core/src/concierge/events.ts": { lines: 1, why: "labels who said it" },
  "packages/core/src/concierge/service.ts": { lines: 1, why: "records who stopped a task" },
  "packages/core/src/people/person-history/application/timeline-sources.ts": {
    lines: 1,
    why: "finds the guardian's person to label a timeline",
  },
  "packages/core/src/connections/kinds/email/email.ts": {
    lines: 4,
    why: "the address `guardian` names the guardian's mailbox",
  },
  "packages/core/src/connections/recorded-sends.ts": {
    lines: 1,
    why: "the address `guardian` names the guardian's mailbox",
  },
  "packages/core/src/connections/device/repository.ts": {
    lines: 2,
    why: "stores what a phone reports about its capabilities",
  },
  "packages/core/src/api/routes/webchat.ts": {
    lines: 4,
    why: "labels an automated sender, names whom a turn acts for and whose phone it pushes to or asks",
  },
  "packages/core/src/routines/engine.ts": {
    lines: 1,
    why: "labels usage by whether a person pressed Run",
  },
  "packages/core/src/index.ts": {
    lines: 1,
    why: "the entry check lets in an agent that acts for the guardian",
  },
  "packages/core/src/people/infrastructure/drizzle-people-repository.ts": {
    lines: 2,
    why: "the guardian's person is never merged or deleted away",
  },
  "packages/core/src/core/guardian-channel.ts": {
    lines: 1,
    why: "a list of channels, it names no person",
  },
};

/** The line numbers, from 1, of the lines in `text` that decide by one of LOOKS. */
export function hitsIn(text: string): number[] {
  const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const code = text.split("");
  const blank = (start: number, end: number) => {
    for (let at = start; at < end; at++) if (code[at] !== "\n") code[at] = " ";
  };
  const visit = (node: ts.Node) => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ]) {
      blank(range.pos, range.end);
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return code
    .join("")
    .split("\n")
    .flatMap((line, at) => (LOOKS.some(({ pattern }) => pattern.test(line)) ? [at + 1] : []));
}

/** What fails, given each file's hit count. */
export function judge(
  counts: ReadonlyMap<string, number>,
  baseline: Readonly<Record<string, number>> = BASELINE,
): string[] {
  const findings: string[] = [];
  for (const file of new Set([...counts.keys(), ...Object.keys(baseline)])) {
    if (file.startsWith(ACCESS)) continue;
    const found = counts.get(file) ?? 0;
    const allowed = ALLOWED[file]?.lines ?? 0;
    const expected = allowed + (baseline[file] ?? 0);
    if (found > expected) {
      findings.push(
        `${file}: ${found - expected} new line(s) decide by the guardian, personal data or the audience. Access answers that once, at the boundary.`,
      );
    } else if (found < expected && found >= allowed) {
      findings.push(
        `${file}: ${expected - found} fewer line(s) than listed. Lower its count in lint/inside-checks-baseline.ts to ${found - allowed}.`,
      );
    } else if (found < allowed) {
      findings.push(`${file}: lower its allowed lines in lint/inside-checks.ts to ${found}.`);
    }
  }
  return findings;
}

function sourceFiles(root: string): string[] {
  return ROOTS.flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$|\.d\.ts$/.test(name))
      .filter((name) => !/(^|\/)test\//.test(name))
      .map((name) => `${dir}/${name}`),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const lines = new Map<string, number[]>();
  for (const file of sourceFiles(root)) {
    const hits = hitsIn(readFileSync(join(root, file), "utf8"));
    if (hits.length > 0) lines.set(file, hits);
  }
  const counts = new Map([...lines].map(([file, hits]) => [file, hits.length]));
  const findings = judge(counts);
  for (const finding of findings) {
    const file = finding.slice(0, finding.indexOf(":"));
    console.error(`${finding}\n  lines: ${(lines.get(file) ?? []).join(", ")}`);
  }
  if (process.argv.includes("--counts")) {
    for (const [file, count] of counts) if (!file.startsWith(ACCESS)) console.log(count, file);
  }
  process.exitCode = findings.length ? 1 : 0;
}
