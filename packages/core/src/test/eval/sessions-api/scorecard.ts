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

/** The session module: the files that make up Sessions. */
const MODULE = ["core/agent-session.ts"].map((file) => join(SRC, file));
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
  /^core\//,
  /^db\//,
  /^actions\/(context|engine|call-action|ipc|approval-handler)\.ts$/,
  /^apps\/context\.ts$/,
  /^connections\/app-connections\.ts$/,
];
// The stored rows themselves: the sessions repository, the row reader, and
// what they keep (a turn's checkpoint).
const BYPASS_SESSION =
  /\b(findReusableSession|findResumableSessionById|findActiveByChannelThreadKey|findByChannelThreadKey|getTurnCheckpoint|sessionsRepo|SessionsRepository|SessionManager|callerKey|callerFromKey|callerOfRun|persistThreadKey)\b/g;
// The wiring builds the repositories and hands them to the session.
const WIRING = ["index.ts"];
const consumerBypasses = coreFiles
  .filter((file) => !SESSION_SIDE.some((pattern) => pattern.test(relative(SRC, file))))
  .filter((file) => !WIRING.includes(relative(SRC, file)))
  .flatMap((file) => (code(file).match(BYPASS_SESSION) ?? []).map((hit) => `${rel(file)}: ${hit}`));
quantities.consumerBypasses = consumerBypasses.length;
checks.push({
  id: "C11",
  name: "Routes, Concierge, capabilities and other users of sessions read no session row and spell no stored caller; they ask the manager",
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
