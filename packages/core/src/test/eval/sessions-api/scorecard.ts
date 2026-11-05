// Scores whether the Sessions API is clear and respected: whether the session
// module keeps out of its callers' business, and whether callers reach it only
// through its entry points. Every check reads the source tree. With --parity,
// it also runs the type check and the core unit tests and compares their
// failures with the baseline in baseline.json.
//
// Run it through ./run.sh. It writes out/scorecard.md and adds one line to
// out/history.jsonl.

import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const HERE = resolve(process.cwd(), "src/test/eval/sessions-api");
const OUT = join(HERE, "out");
const CORE = resolve(HERE, "../../../..");
const SRC = join(CORE, "src");
const REPO = resolve(CORE, "../..");
const PARITY = process.argv.includes("--parity");

/** Sessions' folder. Everything outside it reaches a session through
 *  `PUBLIC` alone (C17). */
const SESSIONS = join(SRC, "agent-sessions");
const PUBLIC = join(SESSIONS, "index.ts");
/** The log over today's rows, the one place Sessions meets Chats' tables
 *  while storage is unchanged. Held to C17, and left out of the checks on
 *  what the session itself knows (C1, C2, C14). */
const ROWS = join(SESSIONS, "rows");
/** The session module: the files that make up Sessions, its row log aside. */
const MODULE = sources(SESSIONS).filter((file) => !file.startsWith(`${ROWS}/`));
/** Where a session's stored key is written and read back. The only place
 *  allowed to spell or parse it. */
const CODEC = ["core/session-caller.ts", "core/agent-session-key.ts"].map((file) =>
  join(SRC, file),
);

const read = (file: string) => readFileSync(file, "utf8");
const rel = (file: string) => relative(REPO, file);

function sources(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      if (["node_modules", "dist", "test", "__tests__", "out"].includes(name)) continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) found.push(path);
    }
  };
  walk(dir);
  return found;
}

const coreFiles = sources(SRC);
const appFiles = readdirSync(join(REPO, "rome_apps"))
  .map((app) => join(REPO, "rome_apps", app, "src"))
  .filter((dir) => existsSync(dir))
  .flatMap(sources);

/** Source text with comments removed, so a check counts code, not prose. */
function code(file: string): string {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, false);
  return ts.createPrinter({ removeComments: true }).printFile(source);
}

interface Check {
  id: string;
  name: string;
  measured: string;
  pass: boolean;
  detail?: string[];
}
const checks: Check[] = [];
const quantities: Record<string, number> = {};

// --- C1 The session imports nothing of its callers ------------------------
const CALLER_MODULES = [
  /db\/repositories\/webchat/,
  /\/sessions\//,
  /\/connections\//,
  /\/routines\//,
  /\/chat-settings\//,
  /\/concierge\//,
  /api-types\/concierge/,
  /guardian-channel/,
  /agent-session-key/,
  /\/webchat\//,
];
const importLines = MODULE.flatMap((file) =>
  [...read(file).matchAll(/from\s+["']([^"']+)["']/g)]
    .map((match) => match[1]!)
    .filter((from) => CALLER_MODULES.some((pattern) => pattern.test(from)))
    .map((from) => `${rel(file)}: ${from}`),
);
quantities.callerImports = importLines.length;
checks.push({
  id: "C1",
  name: "The session imports no caller's module (Chats, connections, routines, chat settings, Concierge, the key parser)",
  measured: `${importLines.length} imports`,
  pass: importLines.length === 0,
  detail: importLines,
});

// --- C2 The session names no platform and runs no caller's policy ---------
const PLATFORM =
  /\b(webchat|telegram|discord|slack|whatsapp|feishu|lark|wechat|email|linkedin|concierge)/gi;
const platformHits = MODULE.flatMap((file) =>
  (code(file).match(PLATFORM) ?? []).map((hit) => `${rel(file)}: ${hit}`),
);
quantities.platformNames = platformHits.length;
checks.push({
  id: "C2",
  name: "The session's code names no platform or caller kind's product (webchat, telegram, Concierge, ...)",
  measured: `${platformHits.length} mentions`,
  pass: platformHits.length === 0,
  detail: [...new Set(platformHits)],
});
const POLICY =
  /\b(turnLinks|unseen|CATCH_UP_LIMIT|evaluateProviderSessionReset|resolveProviderSessionReset|applyProviderSessionReset|connectionKindOfChannel|isGuardianFacingChannel|findChatIdByAddress)\b/g;
const policyHits = MODULE.flatMap((file) =>
  (code(file).match(POLICY) ?? []).map((hit) => `${rel(file)}: ${hit}`),
);
quantities.callerPolicies = policyHits.length;
checks.push({
  id: "C3",
  name: "The caller prepares the briefing and applies the connection's reset policy; the session does neither",
  measured: `${policyHits.length} references`,
  pass: policyHits.length === 0,
  detail: [...new Set(policyHits)],
});

// --- The API's shape, read with the compiler -------------------------------
const declarations = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
for (const file of MODULE) {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  sf.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      declarations.set(node.name.text, node);
  });
}
function members(name: string): string[] {
  const decl = declarations.get(name);
  if (!decl) return [];
  if (ts.isInterfaceDeclaration(decl))
    return decl.members
      .map((member) => member.name?.getText(decl.getSourceFile()) ?? "")
      .filter(Boolean);
  if (ts.isTypeLiteralNode(decl.type))
    return decl.type.members
      .map((member) => member.name?.getText(decl.getSourceFile()) ?? "")
      .filter(Boolean);
  if (
    ts.isTypeReferenceNode(decl.type) &&
    decl.type.typeName.getText(decl.getSourceFile()) === "Pick"
  ) {
    const keys = decl.type.typeArguments?.[1];
    return keys
      ? (keys.getText(decl.getSourceFile()).match(/"([^"]+)"/g) ?? []).map((key) =>
          key.slice(1, -1),
        )
      : [];
  }
  return [];
}
/** The type name of `method`'s parameter at `index` in interface `owner`. */
function paramType(owner: string, method: string, index: number): string | undefined {
  const decl = declarations.get(owner);
  if (!decl || !ts.isInterfaceDeclaration(decl)) return undefined;
  for (const member of decl.members) {
    if (!ts.isMethodSignature(member) || member.name.getText(decl.getSourceFile()) !== method)
      continue;
    const param = member.parameters[index];
    if (param?.type && ts.isTypeReferenceNode(param.type))
      return param.type.typeName.getText(decl.getSourceFile());
  }
  return undefined;
}

const managerMembers = members("AgentSessionManager");
const ENTRY = ["open", "session"];
const BYPASS = ["acquire", "acquireBySessionId", "peek"];
const bypasses = managerMembers.filter((name) => BYPASS.includes(name));
const entries = managerMembers.filter((name) => ENTRY.includes(name));
checks.push({
  id: "C4",
  name: "Callers find a session only through open(agent, caller) and session(id); acquire, acquireBySessionId and peek are gone",
  measured: `entry points: ${entries.join(", ") || "none"}; bypasses: ${bypasses.join(", ") || "none"}`,
  pass: bypasses.length === 0 && entries.length === ENTRY.length,
  detail: managerMembers.map((name) => `AgentSessionManager.${name}`),
});

const REDERIVE =
  /\b(resolveTurnConversation|adhocSessionKey|parseSessionKey|webchatConversationOfKey|key\.channelThreadKey)\b/g;
const rederived = [
  "core/agent-runner.ts",
  "core/agent-session-bridge.ts",
  "core/rpc-agent-runner.ts",
]
  .map((file) => join(SRC, file))
  .flatMap((file) => (code(file).match(REDERIVE) ?? []).map((hit) => `${rel(file)}: ${hit}`));
quantities.rederivations = rederived.length;
checks.push({
  id: "C5",
  name: "The runners hand over a caller and read the turn; they do not re-derive the key or where the turn records",
  measured: `${rederived.length} re-derivations`,
  pass: rederived.length === 0,
  detail: [...new Set(rederived)],
});

// --- C6 One id per session at the API -------------------------------------
/** The type name of `method`'s last parameter in interface `owner`. */
function lastParamType(owner: string, method: string): string | undefined {
  const decl = declarations.get(owner);
  if (!decl || !ts.isInterfaceDeclaration(decl)) return undefined;
  for (const member of decl.members) {
    if (!ts.isMethodSignature(member) || member.name.getText(decl.getSourceFile()) !== method)
      continue;
    return paramType(owner, method, member.parameters.length - 1);
  }
  return undefined;
}
const openOptions =
  lastParamType("AgentSessionManager", "open") ?? paramType("AgentSessionManager", "acquire", 1);
const turnOptions = paramType("AgentSession", "sendTurn", 1);
const SECOND_IDS = ["romeSessionId", "romeSessionType", "resumeSessionId", "channelThreadKey"];
const idFields = [
  ...members(openOptions ?? "")
    .filter((name) => SECOND_IDS.includes(name))
    .map((name) => `${openOptions}.${name}`),
  ...members(turnOptions ?? "")
    .filter((name) => SECOND_IDS.includes(name))
    .map((name) => `${turnOptions}.${name}`),
  ...members("AgentSessionKey")
    .filter((name) => SECOND_IDS.includes(name))
    .map((name) => `AgentSessionKey.${name}`),
];
checks.push({
  id: "C6",
  name: "A caller names a session by one id: no second id (rome session id, resume id, key string) in the open or turn options or the session's key",
  measured: `${idFields.length} second ids`,
  pass: idFields.length === 0,
  detail: idFields,
});

// --- C7 The caller is a typed union of the five kinds ----------------------
// The SDK still names the caller's kinds for apps, which mint and read them.
const SDK_INDEX = join(REPO, "packages/app-runtime-sdk/src/index.ts");
// Sessions takes the caller as an opaque string: a string type, or an alias of one.
const sessionSource = MODULE.map(code).join("\n");
const openCallerType = (() => {
  const decl = declarations.get("AgentSessionManager");
  if (!decl || !ts.isInterfaceDeclaration(decl)) return undefined;
  for (const member of decl.members) {
    if (ts.isMethodSignature(member) && member.name.getText(decl.getSourceFile()) === "open")
      return member.parameters[1]?.type?.getText(decl.getSourceFile());
  }
  return undefined;
})();
const opaqueCaller =
  openCallerType === "string" ||
  (!!openCallerType &&
    new RegExp(`export type ${openCallerType}\\s*=\\s*string\\s*;`).test(sessionSource));
checks.push({
  id: "C7",
  name: "open takes the caller as an opaque string its owning context mints",
  measured: `open's caller: ${openCallerType ?? "none"}; opaque: ${opaqueCaller}`,
  pass: opaqueCaller,
});

const KEY_HELPERS =
  /\b(parseSessionKey|sessionKeyChannel|webchatConversationOfKey|webchatSessionKey|subagentSessionKey|forkSessionKey|adhocSessionKey)\b/g;
const keyHelperUses = coreFiles
  .filter((file) => !CODEC.includes(file))
  .flatMap((file) => (code(file).match(KEY_HELPERS) ?? []).map((hit) => `${rel(file)}: ${hit}`));
quantities.keyHelperUses = keyHelperUses.length;
checks.push({
  id: "C8",
  name: "Only the caller codec spells or parses a session's stored key",
  measured: `${keyHelperUses.length} uses outside the codec`,
  pass: keyHelperUses.length === 0,
  detail: [...new Set(keyHelperUses)],
});

// --- C9 Options carry what the draft lists, not what kind of caller it is --
const LIMIT = 6;
const openCount = members(openOptions ?? "").length;
const turnCount = members(turnOptions ?? "").length;
quantities.openOptionFields = openCount;
quantities.turnOptionFields = turnCount;
checks.push({
  id: "C9",
  name: `Open and turn options carry at most ${LIMIT} fields each`,
  measured: `${openOptions}: ${openCount}, ${turnOptions}: ${turnCount}`,
  pass: openCount <= LIMIT && turnCount <= LIMIT,
  detail: [
    `${openOptions}: ${members(openOptions ?? "").join(", ")}`,
    `${turnOptions}: ${members(turnOptions ?? "").join(", ")}`,
  ],
});

// --- C11 Code that uses sessions reaches them only through the API ----------
// The session's own files, its codec, the repositories, the runners that carry
// an app's run to the session, and the action context that carries a turn's
// caller between hops may spell the stored caller. Everything else (routes,
// Concierge, capabilities, connections, routines, wiring) asks the manager.
const SESSION_SIDE = [
  /^agent-sessions\//,
  /^db\//,
  /^actions\/(context|engine|call-action|ipc|approval-handler)\.ts$/,
  /^apps\/context\.ts$/,
  /^connections\/app-connections\.ts$/,
];
// The stored rows themselves: the sessions repository, the row reader, and
// what they keep (a turn's checkpoint).
// The caller is an opaque string its owning context mints (C7), so minting
// one through the codec (`callerKey`) is the owner's job, not a bypass.
// Parsing a caller back, or reading what the session stored, is.
const BYPASS_SESSION =
  /\b(findReusableSession|findResumableSessionById|findActiveByChannelThreadKey|findByChannelThreadKey|getTurnCheckpoint|sessionsRepo|SessionsRepository|SessionManager|callerFromKey|callerOfRun|persistThreadKey)\b/g;
// The wiring builds the repositories and hands them to the session.
const WIRING = ["index.ts"];
// The codec, and the runners that take an app's run: until the SDK drops the
// deprecated `channelThreadKey`, a run may still name its caller by the
// stored string, and the runner reads it back into the typed caller. Counted
// below, so the debt stays visible.
const CALLER_ADAPTERS = [
  "core/session-caller.ts",
  "core/agent-runner.ts",
  "core/rpc-agent-runner.ts",
];
const adapterReads = CALLER_ADAPTERS.slice(1)
  .map((file) => join(SRC, file))
  .flatMap((file) => code(file).match(/\b(callerFromKey|callerOfRun)\b/g) ?? []);
quantities.deprecatedCallerReads = adapterReads.length;
const consumerBypasses = coreFiles
  .filter((file) => !SESSION_SIDE.some((pattern) => pattern.test(relative(SRC, file))))
  .filter((file) => !WIRING.includes(relative(SRC, file)))
  .filter((file) => !CALLER_ADAPTERS.includes(relative(SRC, file)))
  .flatMap((file) => (code(file).match(BYPASS_SESSION) ?? []).map((hit) => `${rel(file)}: ${hit}`));
quantities.consumerBypasses = consumerBypasses.length;
checks.push({
  id: "C11",
  name: "Routes, Concierge, capabilities and other users of sessions read no session row and parse no caller; they mint it and ask the manager",
  measured: `${consumerBypasses.length} bypasses`,
  pass: consumerBypasses.length === 0,
  detail: [...new Set(consumerBypasses)],
});

// --- C12 Apps name a session by its typed caller ----------------------------
const APP_STORED_CALLER = /(\bchannelThreadKey\b|`sentinel:|["'`]webchat:)/g;
const appStoredCaller = appFiles.flatMap((file) =>
  (code(file).match(APP_STORED_CALLER) ?? []).map((hit) => `${rel(file)}: ${hit}`),
);
quantities.appStoredCaller = appStoredCaller.length;
checks.push({
  id: "C12",
  name: "Apps neither read nor build the stored caller string; they pass and read the typed caller",
  measured: `${appStoredCaller.length} uses`,
  pass: appStoredCaller.length === 0,
  detail: [...new Set(appStoredCaller)],
});

// --- C13 The SDK hands apps the typed caller --------------------------------
const SDK_CARRIERS = [
  "AgentTurnRef",
  "TurnMiddlewareSession",
  "RunParams",
  "ForkRunParams",
  "CurrentActionContext",
];
const sdkSource = ts.createSourceFile(SDK_INDEX, read(SDK_INDEX), ts.ScriptTarget.Latest, true);
const sdkMembers = new Map<string, string[]>();
sdkSource.forEachChild((node) => {
  if (ts.isInterfaceDeclaration(node)) {
    sdkMembers.set(
      node.name.text,
      node.members.flatMap((member) => (member.name ? [member.name.getText(sdkSource)] : [])),
    );
  }
});
const sdkExportsCaller = /export type SessionCaller\b/.test(read(SDK_INDEX));
const missingCaller = SDK_CARRIERS.filter((name) => !sdkMembers.get(name)?.includes("caller"));
checks.push({
  id: "C13",
  name: "The SDK exports the typed caller and every turn, run, fork and action context it hands apps carries it",
  measured: `exports SessionCaller: ${sdkExportsCaller}; missing on: ${missingCaller.join(", ") || "none"}`,
  pass: sdkExportsCaller && missingCaller.length === 0,
});

// --- C14 The session reads no field of the caller ----------------------------
const CALLER_READS =
  /(\bcaller\.(kind|chatId|connection|place|watcher|parent|source|id)\b|\bcallerChatId\b|\bcallerConnection\b|\bcallerFromKey\b|\bcallerKey\b|\bchatOfCaller\b|session-caller\.js)/g;
const callerReads = MODULE.flatMap((file) =>
  (code(file).match(CALLER_READS) ?? []).map((hit) => `${rel(file)}: ${hit}`),
);
quantities.callerReads = callerReads.length;
checks.push({
  id: "C14",
  name: "The session reads no field of the caller and imports no caller codec",
  measured: `${callerReads.length} reads`,
  pass: callerReads.length === 0,
  detail: [...new Set(callerReads)],
});

// --- C15 Open and turn take only what the draft lists -----------------------
const OPEN_LIMIT = 3;
const TURN_LIMIT = 2;
checks.push({
  id: "C15",
  name: `open options carry at most ${OPEN_LIMIT} fields (workingDir, model, effort) and turn options at most ${TURN_LIMIT} (initiator, briefing)`,
  measured: `${openOptions}: ${openCount}, ${turnOptions}: ${turnCount}`,
  pass: openCount <= OPEN_LIMIT && turnCount <= TURN_LIMIT,
});

// --- C16 The session records its own turns ----------------------------------
const sessionMembers = members("AgentSession");
const RECORD_LEAKS = ["recordsTo", "conversation", "forkPoint"].filter((name) =>
  sessionMembers.includes(name),
);
const MANAGER_LEAKS = ["recordConversation"].filter((name) => managerMembers.includes(name));
const turnLeaks = ["execution"].filter((name) => members(turnOptions ?? "").includes(name));
const RUNNERS = [
  "core/agent-runner.ts",
  "core/agent-session-bridge.ts",
  "core/rpc-agent-runner.ts",
];
const RUNNER_RECORDING =
  /\b(AgentTraceRecorder|recordAgentTraceBestEffort|assignConversationMessageTurn|recordsTo)\b/g;
const runnerRecording = RUNNERS.map((file) => join(SRC, file))
  .filter((file) => existsSync(file))
  .flatMap((file) =>
    (code(file).match(RUNNER_RECORDING) ?? []).map((hit) => `${rel(file)}: ${hit}`),
  );
const recordLeaks = [
  ...RECORD_LEAKS.map((name) => `AgentSession.${name}`),
  ...MANAGER_LEAKS.map((name) => `AgentSessionManager.${name}`),
  ...turnLeaks.map((name) => `${turnOptions}.${name}`),
  ...new Set(runnerRecording),
];
checks.push({
  id: "C16",
  name: "The session records its own turns: no member says where a turn is recorded, and the runners record nothing",
  measured: `${recordLeaks.length} leaks`,
  pass: recordLeaks.length === 0,
  detail: recordLeaks,
});

// --- C17 Everything outside Sessions goes through its public module ----------
// Tests and the test kit build sessions from their parts, so only product code
// is held to it.
const internalImports = coreFiles
  .filter((file) => !file.startsWith(`${SESSIONS}/`))
  .flatMap((file) =>
    [...read(file).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)\.js["']/g)]
      .map((match) => match[1]!)
      .map((spec) =>
        spec.startsWith("@/") ? join(SRC, spec.slice(2)) : resolve(join(file, ".."), spec),
      )
      .filter((target) => target.startsWith(`${SESSIONS}/`) && `${target}.ts` !== PUBLIC)
      .map((target) => `${rel(file)}: ${relative(SRC, target)}`),
  );
quantities.internalImports = internalImports.length;
const publicExports = [
  ...read(PUBLIC).matchAll(/^\s+(?:type\s+)?(\w+),?$|export \{ (\w+) \}|export type \{ (\w+) \}/gm),
].length;
quantities.publicExports = publicExports;
checks.push({
  id: "C17",
  name: "Code outside Sessions imports only its public module (agent-sessions/index.ts), never a file inside",
  measured: `${internalImports.length} imports of internals; the public module exports ${publicExports} names`,
  pass: internalImports.length === 0,
  detail: [...new Set(internalImports)],
});

// --- C18 No caller writes a session turn's trace -----------------------------
// The session's log keeps every turn. A caller keeps only what no session
// said (an approval's own call, a turn that failed to start), and no surface
// keeps a turn's whole trace by default.
const TRACE_WRITERS =
  /\b(AgentTraceRecorder|recordAgentTraceBestEffort|recordBatch)\b|\bturn:\s*true\b/g;
const traceWriters = coreFiles
  .filter((file) => !file.startsWith(`${SESSIONS}/`))
  .flatMap((file) => (code(file).match(TRACE_WRITERS) ?? []).map((hit) => `${rel(file)}: ${hit}`));
quantities.callerTraceWriters = traceWriters.length;
checks.push({
  id: "C18",
  name: "No caller writes a session turn's trace: only the session's log does",
  measured: `${traceWriters.length} writers outside Sessions`,
  pass: traceWriters.length === 0,
  detail: [...new Set(traceWriters)],
});

// --- Code tokens by line ------------------------------------------------------
/** Each identifier or string piece of `file`'s code that `pattern` matches and
 *  `accept` takes, keyed by "path:line". Comments are not tokens, so prose
 *  never counts; SQL inside a template or string does. */
function tokenHits(
  file: string,
  pattern: RegExp,
  accept: (node: ts.Node) => boolean = () => true,
): [string, string][] {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const hits: [string, string][] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isIdentifier(node) ||
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      accept(node)
    ) {
      const text = node.getText(sf);
      for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
        const at = node.getStart(sf) + match.index!;
        hits.push([`${rel(file)}:${sf.getLineAndCharacterOfPosition(at).line + 1}`, match[0]]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
/** Hits grouped by line: one place per "path:line", with what it names. */
function places(hits: [string, string][]): string[] {
  const byLine = new Map<string, Set<string>>();
  for (const [at, hit] of hits) byLine.set(at, (byLine.get(at) ?? new Set()).add(hit));
  return [...byLine]
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([at, names]) => `${at}: ${[...names].join(", ")}`);
}
const productFiles = [...coreFiles, ...appFiles];
const outsideSessions = productFiles.filter((file) => !file.startsWith(`${SESSIONS}/`));

// --- C19 Code outside Sessions reads no turn or trace from storage ----------
// A session keeps its turns in `rome_agent_messages` and the trace blocks in
// `rome_agent_trace_blocks`. Only Sessions names those tables; everything else
// asks Sessions' public module, or joins the rows it hands out as SQL
// (`turnRowsOf`). Left out: the schema and migrations, which define the
// tables, and the repository that still holds their readers and writers while
// storage is unchanged. That one is counted, so a reader counts where it is
// called, not where it is defined.
const TURN_SCHEMA = [/^db\/schema(\.ts$|\/)/, /^db\/migrate\.ts$/, /^db\/chats-backfill\.ts$/];
const TURN_STORE = /^db\/repositories\/webchat\.ts$/;
// Not reads of a turn: the health check's schema probe and the dev seed
// script, which writes example traces.
const NOT_TURN_READS = [/^api\/routes\/health\.ts$/, /^bin\//];
const inSrc = (file: string, patterns: RegExp[]) =>
  file.startsWith(`${SRC}/`) && patterns.some((pattern) => pattern.test(relative(SRC, file)));
const turnReaders = outsideSessions.filter(
  (file) => !inSrc(file, [...TURN_SCHEMA, TURN_STORE, ...NOT_TURN_READS]),
);
const TURN_TABLES =
  /\b(rome_agent_messages|romeAgentMessages|rome_agent_trace_blocks|romeAgentTraceBlocks)\b/;
quantities.turnStoreLines = places(
  outsideSessions
    .filter((file) => inSrc(file, [TURN_STORE]))
    .flatMap((file) => tokenHits(file, TURN_TABLES)),
).length;
/** The bodies of the methods of every class in `file`, by name. */
function methodBodies(file: string): Map<string, string> {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const bodies = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && member.name) {
          bodies.set(member.name.getText(sf), member.getText(sf));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bodies;
}
// The turn store's reads: each of its methods that selects from a turn table,
// or calls one that does.
const storeMethods = [...outsideSessions.filter((file) => inSrc(file, [TURN_STORE]))].flatMap(
  (file) => [...methodBodies(file)],
);
const SELECTS_TURNS =
  /\.from\(\s*(romeAgentMessages|romeAgentTraceBlocks|\w*TraceBlocks)\b|\bFROM\s+(\$\{\s*)?(rome_agent_messages|rome_agent_trace_blocks|romeAgentMessages|romeAgentTraceBlocks)\b/i;
// The store Rome runs is Chats' subclass. A read it answers itself, never
// falling back to the store's, reads no turn; any turn rows it joins come
// from Sessions' `turnRowsOf`.
const liveStore = join(SRC, "webchat/chats-webchat-repository.ts");
const answeredByChats = existsSync(liveStore) ? methodBodies(liveStore) : new Map<string, string>();
const answered = (name: string) => {
  const override = answeredByChats.get(name);
  return override !== undefined && !override.includes(`super.${name}(`);
};
const liveStoreReads = new Set(
  storeMethods
    .filter(([name, body]) => SELECTS_TURNS.test(body) && !answered(name))
    .map(([name]) => name),
);
for (let grew = true; grew; ) {
  grew = false;
  for (const [name, body] of storeMethods) {
    if (liveStoreReads.has(name) || answered(name)) continue;
    if ([...liveStoreReads].some((reader) => body.includes(`this.${reader}(`))) {
      liveStoreReads.add(name);
      grew = true;
    }
  }
}
quantities.turnStoreReads = liveStoreReads.size;
// The store's trace readers by name, so a reader that stops naming a table
// still counts. `getMessageContent` and `getMessageContentForDisplay` merge a
// trace row with its blocks.
const TRACE_READERS = new RegExp(
  `^(getTraceContents|getTraceContentByTurn|getTraceContentsByTurns|getMessageContentForDisplay|getMessageContent${[...liveStoreReads].map((name) => `|${name}`).join("")})$`,
);
const isCallee = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
// A trace row read straight from storage: SQL that names the role, or a
// drizzle `eq(<table>.role, "trace")`.
const isTraceRole = (node: ts.Node) =>
  !(ts.isStringLiteral(node) && node.text === "trace") ||
  (ts.isCallExpression(node.parent) &&
    node.parent.arguments.length === 2 &&
    node.parent.arguments[1] === node &&
    /\.role$/.test(node.parent.arguments[0]!.getText()));
const traceReads = places(
  turnReaders.flatMap((file) => [
    ...tokenHits(file, TRACE_READERS, isCallee),
    ...tokenHits(file, TURN_TABLES),
    ...tokenHits(file, /\brole\s*=\s*'trace'|^["']trace["']$/, isTraceRole),
  ]),
);
quantities.callerTraceReads = traceReads.length;
checks.push({
  id: "C19",
  name: "Code outside Sessions names no turn table: it reads turns and traces through Sessions' public module",
  measured: `${traceReads.length} reads outside Sessions`,
  pass: traceReads.length === 0,
  detail: traceReads,
});

// --- C20 The session keeps the whole turn itself ----------------------------
// Every session writes the turn's prompt, answer and trace to its own tables.
// Chats keeps its own copy of the prompt and answer, so no caller tells the
// session to leave any of it out: no surface says what it keeps, and no run
// option turns a part of the record off. The row log under `rows/` may still
// name its writer's switches while storage is unchanged.
const keepsMember = members("SessionSurface").includes("keeps") ? ["SessionSurface.keeps"] : [];
// A field named `keeps`, passed, declared or read; a local of that name is not one.
const isField = (node: ts.Node) =>
  ts.isIdentifier(node) &&
  (ts.isPropertyAssignment(node.parent) ||
    ts.isShorthandPropertyAssignment(node.parent) ||
    ts.isPropertySignature(node.parent) ||
    ts.isPropertyAccessExpression(node.parent)) &&
  node.parent.name === node;
// The run options that turn a part of the record off, also as a `Pick` key.
const SKIP_OPTIONS =
  /^["']?(persistUserTranscript|persistAssistantTranscript|persistAnswer|persistTranscript|persistTrace)["']?$/;
const skips = [
  ...keepsMember,
  ...places([
    ...productFiles.flatMap((file) => tokenHits(file, /^SurfaceKeeps$/, ts.isIdentifier)),
    ...outsideSessions.flatMap((file) => tokenHits(file, /^keeps$/, isField)),
    ...productFiles
      .filter((file) => !file.startsWith(`${ROWS}/`))
      .flatMap((file) => tokenHits(file, SKIP_OPTIONS)),
  ]),
];
quantities.skipInstructions = skips.length;
checks.push({
  id: "C20",
  name: "The session keeps the whole turn itself: prompt, answer and trace go to its own tables for every session, and no caller tells it what to skip",
  measured: `${skips.length} places tell the session what to skip`,
  pass: skips.length === 0,
  detail: skips,
});

// --- C21 A running turn keeps what its opener lent ----------------------------
// Several openers can hold one session, and each lends its surface for its own
// turns. While a turn runs, its reply address and shared context are the ones
// it captured, even when it captured none: nothing falls back from the turn's
// sink to the latest opener's surface or to a context a queued turn set.
const CAPTURED = /^(threadContext|sharedContext)$/;
const borrowed: [string, string][] = [];
for (const file of MODULE) {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isPropertyAccessExpression(node.left) &&
      CAPTURED.test(node.left.name.text) &&
      /sink$/i.test(node.left.expression.getText(sf)) &&
      /^this\.(surface|sharedContext)\b/.test(node.right.getText(sf))
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      borrowed.push([`${rel(file)}:${line}`, node.getText(sf)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
const borrowedPlaces = places(borrowed);
quantities.turnFallbacks = borrowedPlaces.length;
checks.push({
  id: "C21",
  name: "A running turn keeps the reply address and shared context it captured; nothing falls back to the latest opener's surface or a queued turn's context",
  measured: `${borrowedPlaces.length} fallbacks`,
  pass: borrowedPlaces.length === 0,
  detail: borrowedPlaces,
});

// --- Quantities without a target -------------------------------------------
quantities.moduleLines = MODULE.reduce((sum, file) => sum + read(file).split("\n").length, 0);
const APP_KEY_PARSING =
  /(channelThreadKey[^\n]*(startsWith|split|exec|match)\(|WEBCHAT_CHAT_KEY|`sentinel:)/g;
const appKeyParsing = appFiles.flatMap((file) =>
  (code(file).match(APP_KEY_PARSING) ?? []).map(() => rel(file)),
);
quantities.appKeyParsing = appKeyParsing.length;

// --- C10 Parity ------------------------------------------------------------
interface Baseline {
  typecheckErrors: number;
  unitFailures: string[];
}
const baselineFile = join(HERE, "baseline.json");
const baseline: Baseline | undefined = existsSync(baselineFile)
  ? JSON.parse(read(baselineFile))
  : undefined;

function run(command: string): string {
  try {
    return execSync(command, {
      cwd: CORE,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 28,
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
  }
}
if (PARITY) {
  const typecheck = run("pnpm exec tsc --noEmit");
  const typecheckErrors = (typecheck.match(/error TS\d+/g) ?? []).length;
  const unit = run(
    "../../scripts/test-env.sh pnpm exec rstest --exclude '**/*.integration.test.ts' --exclude '**/*.e2e.test.ts'",
  );
  writeFileSync(join(OUT, "unit.log"), unit);
  // rstest prints a failed test file as "✗ <path>" (with ANSI colors stripped).
  const plain = unit.replace(/\u001b\[[0-9;]*m/g, "");
  const unitFailures = [
    ...new Set([...plain.matchAll(/^\s*✗\s+(\S+\.test\.ts)/gm)].map((match) => match[1]!)),
  ].sort();
  const unitSummary = plain.match(/Test Files.*$/m)?.[0] ?? "no summary";
  quantities.typecheckErrors = typecheckErrors;
  quantities.unitFailedFiles = unitFailures.length;
  if (process.argv.includes("--baseline")) {
    writeFileSync(baselineFile, `${JSON.stringify({ typecheckErrors, unitFailures }, null, 2)}\n`);
  }
  const newFailures = baseline
    ? unitFailures.filter((file) => !baseline.unitFailures.includes(file))
    : [];
  checks.push({
    id: "C10",
    name: "Behaviour holds: no type error and no failing unit test file beyond the baseline",
    measured: `type errors ${typecheckErrors} (baseline ${baseline?.typecheckErrors ?? "?"}); ${unitSummary}; new failing files ${newFailures.length}`,
    pass:
      baseline !== undefined &&
      typecheckErrors <= baseline.typecheckErrors &&
      newFailures.length === 0,
    detail: newFailures,
  });
}

// --- Output ------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const commit = run("git rev-parse --short HEAD").trim();
const branch = run("git rev-parse --abbrev-ref HEAD").trim();
const passed = checks.filter((check) => check.pass).length;
const lines = [
  `# Sessions API scorecard`,
  "",
  `${branch} @ ${commit}: ${passed}/${checks.length} checks pass`,
  "",
  "| Check | Measured | Result |",
  "|---|---|---|",
  ...checks.map(
    (check) =>
      `| ${check.id} ${check.name} | ${check.measured} | ${check.pass ? "pass" : "FAIL"} |`,
  ),
  "",
  "## Quantities",
  "",
  ...Object.entries(quantities).map(([name, value]) => `- ${name}: ${value}`),
  "",
  "## Details",
  "",
  ...checks
    .filter((check) => check.detail && check.detail.length > 0)
    .flatMap((check) => [`### ${check.id}`, "", ...check.detail!.map((line) => `- ${line}`), ""]),
];
writeFileSync(join(OUT, "scorecard.md"), `${lines.join("\n")}\n`);
appendFileSync(
  join(OUT, "history.jsonl"),
  `${JSON.stringify({
    at: new Date().toISOString(),
    branch,
    commit,
    passed,
    total: checks.length,
    checks: Object.fromEntries(checks.map((check) => [check.id, check.pass])),
    quantities,
  })}\n`,
);
console.log(lines.join("\n"));
