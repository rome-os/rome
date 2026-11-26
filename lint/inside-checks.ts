// Rome asks who may enter once, where someone comes in, and nothing past that
// point asks again (docs/domains/participation.md#entry). This lint finds code
// that still decides by whether someone is the guardian, or by personal data
// and the audience of a chat. It reads source text, so a hit is a line that
// names one of those, with comments, imports and types left out.
//
// A hit is allowed for good when Access answers who the guardian is, or when
// ALLOWED names its line and why it stays. Every other hit is counted in
// inside-checks-baseline.ts, which only shrinks: a file with more such lines
// than listed fails, and so does one with fewer, until its count is lowered.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BASELINE } from "./inside-checks-baseline.js";

/** Words that decide by whether someone is the guardian, then by personal data or the audience. */
const LOOKS: readonly RegExp[] = [
  /[!=]==?\s*"(guardian|visitor)"|"(guardian|visitor)"\s*[!=]==?|\bcase\s+"(guardian|visitor)"|"guardian"\]\.includes|\bvia\s*[!=]==?\s*"(cookie|loopback)"|\b(is|needs|only)_?[Gg]uardian|guardian_?[Oo]nly|GUARDIAN_ONLY/,
  /isPersonalDataAction|readsPersonalData|PERSONAL_DATA_(?!SOURCES\b|CATALOG_ACTION\b|QUERY_ACTION\b)\w+|\.personal\b|\b\w*[Aa]udience(?!_mismatch)\w*|AUDIENCE|private_only/,
];

const ROOTS = ["packages/core/src", "packages/rome-node-cli/src"];

/** Where Access answers who the guardian is. */
const ACCESS = "packages/core/src/access/";

/** Lines that stay in a file, as hitsIn reads them (types left out, spaces collapsed), and why. */
interface Allowed {
  why: string;
  lines: readonly string[];
}

const ALLOWED: Readonly<Record<string, Allowed>> = {
  "packages/core/src/api/routes/vault.ts": {
    lines: [
      'actor.kind === "guardian" &&',
      'actor.via !== "cookie"',
      'if (enteredPerson(c).kind !== "guardian")',
    ],
    why: "only the guardian resets the vault, and a shell never types its PIN",
  },
  "packages/core/src/api/routes/account-codes.ts": {
    lines: [
      'if (actor.kind === "guardian") {',
      'return (await access.members()).find((m) => m.role === "guardian")?.personId ?? null;',
      'if (actor.kind === "guardian" && actor.via !== "cookie") {',
    ],
    why: "links an account to the guardian's person",
  },
  "packages/core/src/personal-data/routes.ts": {
    lines: ['if (!reads && actor.kind !== "guardian") {'],
    why: "personal data comes from the guardian's phone",
  },
  "packages/core/src/api/routes/device-connections.ts": {
    lines: ['if (!reads && actor.kind !== "guardian") {'],
    why: "devices are reported by the guardian's phone",
  },
  "packages/core/src/api/routes/apps.ts": {
    lines: [
      "permissions.get(view.appId) ?? GUARDIAN_ONLY,",
      "const permission = permissions.get(appId) ?? GUARDIAN_ONLY;",
    ],
    why: "who may open an app is the app's own permission",
  },
  "packages/core/src/api/routes/app-websocket-server.ts": {
    lines: ['if (caller.kind === "guardian") {', 'if (caller.kind === "visitor") {'],
    why: "who may open an app is the app's own permission",
  },
  "packages/core/src/api/routes/auth.ts": {
    lines: [
      'if (actor?.kind === "guardian") {',
      'return actor.kind === "visitor" ? actor : null;',
      'if (actor.kind === "guardian") applyGuardianHeaders(c, actor);',
    ],
    why: "signs in the guardian's seat",
  },
  "packages/core/src/api/routes/cloud-login.ts": {
    lines: ["audience: OAUTH_CLIENT_ID,"],
    why: "the audience of a Rome Cloud token",
  },
  "packages/core/src/instance/instance-identity.ts": {
    lines: [
      "async function audienceMatches(socket: ): {",
      "if (socket && !(await audienceMatches(socket))) {",
    ],
    why: "the audience the signing service is set up for",
  },
  "packages/core/src/api/routes/chat-settings.ts": {
    lines: [
      'return { kind: person?.kind === "visitor" ? "member" : "guardian", id: "dashboard" };',
    ],
    why: "records whose settings change it is",
  },
  "packages/core/src/api/routes/approvals.ts": {
    lines: ['return actor.kind === "guardian" ? actor.userId : `visitor:${actor.accountId}`;'],
    why: "names whose approval it is",
  },
  "packages/core/src/api/routes/chat-senders.ts": {
    lines: [
      '...new Set(list.flatMap((actor) => (actor.kind === "visitor" ? [actor.accountId] : []))),',
      'if (list.some((actor) => actor.kind === "guardian")) {',
      'if (actor.kind === "guardian" && guardian) {',
      '} else if (actor.kind === "visitor") {',
      'actor?.kind === "guardian" &&',
    ],
    why: "labels who said it",
  },
  "packages/core/src/api/routes/webchat-reply.ts": {
    lines: [': (name ?? (author === "guardian" ? "Guardian" : "Rome")),'],
    why: "labels who said it",
  },
  "packages/core/src/app-host/api.ts": {
    lines: ['return caller.kind === "guardian" && caller.via === "loopback" ? "fail" : "queue";'],
    why: "a shell waits for a busy worker, it is not refused",
  },
  "packages/core/src/app-host/caller-notify.ts": {
    lines: [
      'if (caller.actor?.kind === "visitor") return { recipient: caller.actor.accountId };',
      'if (caller.actor?.kind === "guardian") return { recipient: recipientOf(GUARDIAN_OWNER) };',
    ],
    why: "names whom to notify",
  },
  "packages/core/src/live-events-server.ts": {
    lines: ['const owner = actor.kind === "guardian" ? "guardian" : `visitor:${actor.accountId}`;'],
    why: "names whose chats to stream",
  },
  "packages/core/src/usage/attribution.ts": {
    lines: [
      'if (actor?.kind === "visitor" || (actor?.kind === "guardian" && actor.via === "cookie")) {',
      'if (actor?.kind === "guardian") return "background";',
    ],
    why: "labels usage by who caused it",
  },
  "packages/core/src/webchat/automated-source.ts": {
    lines: ['actorKind === "guardian" &&'],
    why: "labels who said it",
  },
  "packages/core/src/webchat/chats-webchat-repository.ts": {
    lines: [
      'if (actor?.kind === "visitor") {',
      'if (senderId === "guardian") return { kind: "guardian", userId: "guardian", via: "cookie" };',
    ],
    why: "reads a stored sender back",
  },
  "packages/core/src/webchat/repository.ts": {
    lines: [': ownerKey === "guardian"', 'ownerKey === "guardian"'],
    why: "reads a stored owner back",
  },
  "packages/core/src/db/repositories/concierge-tasks.ts": {
    lines: ['owner === "guardian" ? isNull(romeSessions.ownerKey) : undefined,'],
    why: "reads a stored owner back",
  },
  "packages/core/src/concierge/task-schedule.ts": {
    lines: ['const floating = task.owner === "guardian";'],
    why: "a task of the guardian's runs in the guardian's time zone",
  },
  "packages/core/src/concierge/events.ts": {
    lines: [
      'const said = by === "guardian" ? `guardian: ${excerpt(words, DETAIL_EXCERPT_CHARS)}` : null;',
    ],
    why: "labels who said it",
  },
  "packages/core/src/concierge/service.ts": {
    lines: ['return this.endTaskWork(taskId, by === "guardian" ? "stopped_by_owner" : null);'],
    why: "records who stopped a task",
  },
  "packages/core/src/people/person-history/application/timeline-sources.ts": {
    lines: [
      'const guardian = (await deps.peopleRepo.all()).find((person) => person.bondLevel === "guardian");',
    ],
    why: "finds the guardian's person to label a timeline",
  },
  "packages/core/src/connections/kinds/email/email.ts": {
    lines: [
      'if (raw.toLowerCase() === "guardian") return this.guardianEmail || raw;',
      '(!!this.resolveRecipients(threadId) || threadId.trim().toLowerCase() === "guardian");',
      '(!!this.resolveRecipients(threadId) || threadId.trim().toLowerCase() === "guardian");',
      'if (values.some((value) => value.toLowerCase() === "guardian") && !this.guardianEmail) {',
    ],
    why: "the address `guardian` names the guardian's mailbox",
  },
  "packages/core/src/connections/recorded-sends.ts": {
    lines: ['const named = address.trim().toLowerCase() === "guardian" || address.includes("@");'],
    why: "the address `guardian` names the guardian's mailbox",
  },
  "packages/core/src/connections/device/repository.ts": {
    lines: ["personal: connection.personal,", "personal: row.personal,"],
    why: "stores what a phone reports about its capabilities",
  },
  "packages/core/src/api/routes/webchat.ts": {
    lines: [
      'case "guardian":',
      'case "visitor":',
      'actor?.kind === "guardian" &&',
      'actor.via === "loopback" &&',
      'actor?.kind === "guardian" && !saidBy',
      'return actor?.kind === "guardian" || actor?.kind === "visitor" ? actor : undefined;',
      'return actor?.kind === "visitor" || (actor?.kind === "guardian" && actor.via === "cookie");',
    ],
    why: "logs who acted, labels an automated sender, names whom a turn acts for and whose phone it pushes to or asks",
  },
  "packages/core/src/routines/engine.ts": {
    lines: [
      'presser?.kind === "visitor" || (presser?.kind === "guardian" && presser.via === "cookie");',
    ],
    why: "labels usage by whether a person pressed Run",
  },
  "packages/core/src/index.ts": {
    lines: ['return person?.bondLevel === "guardian" && whoIs(account, person).delegate;'],
    why: "the entry check lets in an agent that acts for the guardian",
  },
  "packages/core/src/people/infrastructure/drizzle-people-repository.ts": {
    lines: [
      'if (protectedPersonReason(source) === "guardian") {',
      'if (protectedPersonReason(row) === "guardian") return { deleted: false, reason: "guardian" };',
    ],
    why: "the guardian's person is never merged or deleted away",
  },
  "packages/core/src/core/guardian-channel.ts": {
    lines: ["export function isGuardianFacingChannel("],
    why: "a list of channels, it names no person",
  },
};

/** One line that decides by one of LOOKS: its number, from 1, and its text. */
export interface Hit {
  line: number;
  text: string;
}

/** Whether `node` only names a type or a module, and so decides nothing. */
const namesOnly = (node: ts.Node) =>
  ts.isImportDeclaration(node) ||
  (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) ||
  ts.isTypeAliasDeclaration(node) ||
  ts.isInterfaceDeclaration(node) ||
  ts.isTypeNode(node);

/** The lines of `text` that decide by one of LOOKS, leaving out comments, imports and types. */
export function hitsIn(text: string): Hit[] {
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
    if (node !== source && namesOnly(node)) blank(node.getStart(source), node.end);
    else for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  // Matched over the whole text, so a comparison split across lines counts on
  // the line it starts on.
  const kept = code.join("");
  const lines = kept.split("\n");
  const starts = new Set<number>();
  for (const pattern of LOOKS) {
    for (const { index } of kept.matchAll(new RegExp(pattern.source, "g"))) {
      starts.add(kept.slice(0, index).split("\n").length);
    }
  }
  return [...starts]
    .sort((a, b) => a - b)
    .map((line) => ({ line, text: lines[line - 1]!.replace(/\s+/g, " ").trim() }));
}

/** What fails, given the text of each file's hits. */
export function judge(
  hits: ReadonlyMap<string, readonly string[]>,
  baseline: Readonly<Record<string, number>> = BASELINE,
  allowed: Readonly<Record<string, Allowed>> = ALLOWED,
): string[] {
  const findings: string[] = [];
  for (const file of new Set([...hits.keys(), ...Object.keys(baseline), ...Object.keys(allowed)])) {
    if (file.startsWith(ACCESS)) continue;
    const left = [...(hits.get(file) ?? [])];
    for (const text of allowed[file]?.lines ?? []) {
      const at = left.indexOf(text);
      if (at >= 0) left.splice(at, 1);
      else
        findings.push(
          `${file}: \`${text}\` is gone. Take it off ALLOWED in lint/inside-checks.ts.`,
        );
    }
    const listed = baseline[file] ?? 0;
    if (left.length > listed) {
      findings.push(
        `${file}: ${left.length - listed} new line(s) decide by the guardian, personal data or the audience. Access answers that once, at the boundary.`,
      );
    } else if (left.length < listed) {
      findings.push(
        `${file}: ${listed - left.length} fewer line(s) than listed. Lower its count in lint/inside-checks-baseline.ts to ${left.length}.`,
      );
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
  const found = new Map<string, Hit[]>();
  for (const file of sourceFiles(root)) {
    const hits = hitsIn(readFileSync(join(root, file), "utf8"));
    if (hits.length > 0) found.set(file, hits);
  }
  const texts = new Map([...found].map(([file, hits]) => [file, hits.map(({ text }) => text)]));
  const findings = judge(texts);
  for (const finding of findings) {
    const file = finding.slice(0, finding.indexOf(":"));
    const lines = (found.get(file) ?? []).map(({ line }) => line);
    console.error(`${finding}\n  lines that count: ${lines.join(", ")}`);
  }
  if (process.argv.includes("--hits")) console.log(JSON.stringify(Object.fromEntries(texts)));
  process.exitCode = findings.length ? 1 : 0;
}
