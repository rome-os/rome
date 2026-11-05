// Builds the eval's scorecard: the boundary checks' outcomes (out/boundary.json,
// written by boundary.eval.test.ts) by quality and platform, and the
// quantities, measured here from the source. Writes out/scorecard.md and adds
// one line per run to out/history.jsonl, so runs can be compared over time.
// Run it through ./run.sh, from anywhere in the repo.

import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { OUT_DIR, type Outcome } from "./results.js";

const CORE = resolve(OUT_DIR, "../../../../..");
const REPO = resolve(CORE, "../..");
const SRC = join(CORE, "src");

/** Every non-test TypeScript file under `dir`. */
function sources(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      if (name === "node_modules" || name === "dist" || name === "test" || name === "__tests__")
        continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (
        /\.tsx?$/.test(name) &&
        !/\.(test|spec|integration\.test|e2e\.test)\.tsx?$/.test(name)
      )
        found.push(path);
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
const shared = [...coreFiles, ...appFiles].filter(
  (file) => !file.includes("/connections/kinds/") && !file.includes("/connections/integrations/"),
);
const rel = (file: string) => relative(REPO, file);
const read = (file: string) => readFileSync(file, "utf8");

// --- Q7: platform names outside their connection kind ---------------------
const PLATFORM_NAMES = [
  "telegram",
  "telegram-user",
  "whatsapp",
  "feishu",
  "lark",
  "discord",
  "slack",
  "wechat",
  "wechat-user",
  "email",
  "linkedin",
  "webchat",
];
const literal = new RegExp(`["'\`](${PLATFORM_NAMES.join("|")})["'\`]`, "g");
const literalHits = shared
  .map((file) => ({ file: rel(file), hits: read(file).match(literal)?.length ?? 0 }))
  .filter((at) => at.hits > 0)
  .sort((a, b) => b.hits - a.hits);
const literalTotal = literalHits.reduce((sum, at) => sum + at.hits, 0);

// --- Q8: code outside connections/ that reaches the connection's ports ----
const PORT_TYPES = [
  "Channel",
  "ChannelSend",
  "ChannelInbound",
  "ChannelsService",
  "InboundEvent",
  "ChannelMessage",
];
const sdkImport = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@rome-os\/app-runtime["']/g;
const portUsers = shared
  .filter((file) => !file.includes("/connections/"))
  .map((file) => {
    const named = [...read(file).matchAll(sdkImport)]
      .flatMap((match) => match[1]!.split(","))
      .map(
        (name) =>
          name
            .replace(/^\s*type\s+/, "")
            .trim()
            .split(/\s+as\s+/)[0]!,
      )
      .filter((name) => PORT_TYPES.includes(name));
    return { file: rel(file), named: [...new Set(named)] };
  })
  .filter((at) => at.named.length > 0);

// --- Q8: send entry points and inbound paths still present ---------------
/** A path is present while its marker is in its file. */
const marker = (file: string, text: string) => {
  const path = join(SRC, file);
  return existsSync(path) && read(path).includes(text);
};
const sendPaths = [
  {
    name: "ChatAdapter.send / stream",
    present: marker("connections/chat-adapter.ts", "send(chatKey"),
  },
  { name: "connections/send.ts", present: existsSync(join(SRC, "connections/send.ts")) },
  {
    name: "app deps.chats (app-chats.ts)",
    present: existsSync(join(SRC, "connections/app-chats.ts")),
  },
  {
    name: "hook ports by address (recorded-sends.ts)",
    present: existsSync(join(SRC, "connections/recorded-sends.ts")),
  },
  { name: "ChannelsService.send", present: marker("apps/accounts-service.ts", "send(") },
  {
    name: "approval cards (recordedCardChannels)",
    present: marker("index.ts", "recordedCardChannels"),
  },
  {
    name: "platform requests (platform-requests.ts)",
    present: existsSync(join(SRC, "apps/platform-requests.ts")),
  },
];
const inboundPaths = [
  { name: "deliver", present: marker("connections/chat-adapter.ts", "deliver") },
  {
    name: "history sync (recordSynced)",
    present: marker("connections/history-recording.ts", "recordSynced"),
  },
  {
    name: "raw event to hooks (heard)",
    present: marker("connections/inbound-recording.ts", "heard("),
  },
];
const sdk =
  read(join(REPO, "packages/app-runtime-sdk/src/index.ts")) +
  read(join(REPO, "packages/app-runtime-sdk/src/chats.ts"));
const errorVocabularies = ["class SendRefused", "class SendError"].filter((name) =>
  sdk.includes(name),
).length;

// --- Q6: capabilities a connection kind declares -------------------------
const DECLARABLE = [
  "quote",
  "threads",
  "partTypes",
  "attachmentTypes",
  "streaming",
  "directMessages",
  "addressNamesKind",
  "perAccountNumbering",
  "redeliveryPosition",
];
const types = read(join(SRC, "connections/types.ts"));
const declared = DECLARABLE.filter((name) => new RegExp(`\\b${name}\\??:`).test(types));

// --- Q8 coverage: connection kinds that can chat, and which the eval runs --
const integrations = join(SRC, "connections/integrations");
const chatKinds = readdirSync(integrations)
  .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
  .filter((name) => /\btalker\s*:/.test(read(join(integrations, name))))
  .map((name) => name.replace(/\.ts$/, ""));

// --- Boundary outcomes ----------------------------------------------------
const outcomesPath = join(OUT_DIR, "boundary.json");
const outcomes: Outcome[] = existsSync(outcomesPath) ? JSON.parse(read(outcomesPath)) : [];
const platforms = [...new Set(outcomes.map((at) => at.platform))];
const qualities = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"] as const;
const covered = chatKinds.filter(
  (kind) =>
    platforms.some((platform) => kind.startsWith(platform.toLowerCase())) &&
    !kind.endsWith("-user"),
);

const cell = (quality: string, platform: string) => {
  const of = outcomes.filter(
    (at) => at.quality === quality && at.platform === platform && at.outcome !== "n/a",
  );
  if (!of.length) return "n/a";
  const passed = of.filter((at) => at.outcome === "pass").length;
  return `${passed === of.length ? "✅" : passed === 0 ? "❌" : "🟡"} ${passed}/${of.length}`;
};

const sha = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim();
  } catch {
    return "unknown";
  }
})();
const date = new Date().toISOString();
const checked = outcomes.filter((at) => at.outcome !== "n/a");
const passedChecks = checked.filter((at) => at.outcome === "pass").length;

const lines: string[] = [];
lines.push(`# Chats and adapter eval`, "");
lines.push(
  `Run ${date} at \`${sha}\`. Boundary checks passed: ${passedChecks} of ${checked.length}.`,
  "",
);
lines.push("## Qualities by platform", "");
lines.push(
  `| Quality | ${platforms.join(" | ")} |`,
  `|---|${platforms.map(() => "---").join("|")}|`,
);
const QUALITY_NAMES: Record<string, string> = {
  Q1: "Nothing is lost quietly",
  Q2: "Handed over exactly once",
  Q3: "Ordered",
  Q4: "Same conversation, same chat",
  Q5: "One truth",
  Q6: "Declared equals actual",
};
for (const quality of qualities)
  lines.push(
    `| ${quality} ${QUALITY_NAMES[quality]} | ${platforms.map((p) => cell(quality, p)).join(" | ")} |`,
  );
lines.push("");
lines.push("## Quantities", "");
lines.push("| Quantity | Now | Target |", "|---|---|---|");
lines.push(
  `| Q7 Platform name literals outside \`connections/kinds/\` and \`connections/integrations/\` | ${literalTotal} in ${literalHits.length} files | 0 outside an allowed list |`,
);
lines.push(
  `| Q8 Files outside \`connections/\` importing the connection's port types | ${portUsers.length} | 0 |`,
);
lines.push(`| Q8 Send entry points | ${sendPaths.filter((at) => at.present).length} | 1 |`);
lines.push(`| Q8 Inbound paths | ${inboundPaths.filter((at) => at.present).length} | 1 |`);
lines.push(`| Q1 Error vocabularies for a refused send | ${errorVocabularies} | 1 |`);
lines.push(
  `| Q6 Capabilities a connection kind can declare | ${declared.length} of ${DECLARABLE.length} | ${DECLARABLE.length} |`,
);
lines.push(
  `| Coverage: chat-capable connection kinds the eval runs | ${covered.length} of ${chatKinds.length} | all |`,
);
lines.push("");
lines.push("## What fails", "");
for (const at of outcomes.filter((o) => o.outcome === "fail"))
  lines.push(`- **${at.quality} ${at.platform}:** ${at.check}. ${at.detail ?? ""}`);
lines.push("");
lines.push("## Detail", "");
lines.push(
  `Capabilities not yet declarable: ${
    DECLARABLE.filter((name) => !declared.includes(name))
      .map((n) => `\`${n}\``)
      .join(", ") || "none"
  }.`,
  "",
);
lines.push(
  `Chat-capable kinds the eval does not run: ${
    chatKinds
      .filter((k) => !covered.includes(k))
      .map((k) => `\`${k}\``)
      .join(", ") || "none"
  }.`,
  "",
);
lines.push(
  "Send entry points present:",
  ...sendPaths.filter((at) => at.present).map((at) => `- ${at.name}`),
  "",
);
lines.push(
  "Inbound paths present:",
  ...inboundPaths.filter((at) => at.present).map((at) => `- ${at.name}`),
  "",
);
lines.push(
  "Files outside `connections/` importing port types:",
  ...portUsers.map((at) => `- \`${at.file}\` (${at.named.join(", ")})`),
  "",
);
lines.push(
  "Platform name literals, most first:",
  ...literalHits.slice(0, 25).map((at) => `- \`${at.file}\`: ${at.hits}`),
);
if (literalHits.length > 25) lines.push(`- and ${literalHits.length - 25} more files`);
lines.push("");

writeFileSync(join(OUT_DIR, "scorecard.md"), lines.join("\n"));
appendFileSync(
  join(OUT_DIR, "history.jsonl"),
  `${JSON.stringify({
    date,
    sha,
    checks: { passed: passedChecks, of: checked.length },
    byQuality: Object.fromEntries(
      qualities.map((q) => {
        const of = checked.filter((at) => at.quality === q);
        return [q, `${of.filter((at) => at.outcome === "pass").length}/${of.length}`];
      }),
    ),
    literals: literalTotal,
    portUsers: portUsers.length,
    sendPaths: sendPaths.filter((at) => at.present).length,
    inboundPaths: inboundPaths.filter((at) => at.present).length,
    errorVocabularies,
    declared: declared.length,
    coverage: `${covered.length}/${chatKinds.length}`,
  })}\n`,
);
process.stdout.write(
  `${lines.slice(0, 4 + qualities.length + 14).join("\n")}\nFull scorecard: ${rel(join(OUT_DIR, "scorecard.md"))}\n`,
);
