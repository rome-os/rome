import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AuditItem, AuditQuery, AuditStore, ContentName } from "@rome-os/node-core/host";

/** The CLI's own audit log. The Mac app keeps a separate one in ~/.rome-desktop/audit/. */
export const cliAuditPath = (configDirectory: string) => join(configDirectory, "audit", "audit.db");

/** What a caller refused by this host is told to do. */
export const CLI_AUDIT_HINT = "Run rome-node audit status on that computer.";

export interface AuditOptions {
  db?: string;
  json?: boolean;
  follow?: boolean;
  lines?: string;
  since?: string;
  until?: string;
  action?: string;
  outcome?: string;
  text?: string;
  content?: string;
  out?: string;
}

const OUTCOMES = ["ok", "exit_nonzero", "error", "interrupted", "no_end"];
const CONTENT: ContentName[] = ["stdin", "stdout", "stderr", "file"];

function time(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at))
    throw new Error(`${flag} must be a date or time, such as 2026-11-02T09:00.`);
  return at;
}

function describe(item: AuditItem): string {
  const args = (item.record.args ?? {}) as Record<string, unknown>;
  if (item.kind === "host")
    return `host ${String(item.record.event)} ${String(item.record.status ?? "")}`.trim();
  if (item.kind === "prune") return `prune (${String(item.record.reason)})`;
  if (item.action === "exec")
    return [args.command, ...((Array.isArray(args.args) ? args.args : []) as unknown[])]
      .map((part) => {
        const text = String(part);
        return /^[\w@%+=:,./-]+$/.test(text) ? text : JSON.stringify(text);
      })
      .join(" ");
  if (item.action === "fs.list") return `fs.list ${String(args.path ?? "~")}`;
  if (item.action === "transfer.open") return `${String(args.direction)} ${String(args.path)}`;
  return String(item.action);
}

/** One line per record: seq, time, what, outcome, duration, and the unverified sender. */
function auditLine(item: AuditItem): string {
  const what = describe(item);
  const outcome =
    item.kind !== "start" ? "" : item.end ? (item.end.outcome ?? "") : "no end record";
  const code = item.end?.record.errorCode ? ` ${String(item.end.record.errorCode)}` : "";
  const exit = item.end?.record.exitCode != null ? ` exit=${String(item.end.record.exitCode)}` : "";
  const duration =
    item.end?.record.durationMs != null ? ` ${String(item.end.record.durationMs)}ms` : "";
  const from = item.record.from ? ` from=${String(item.record.from)} (unverified)` : "";
  return `${item.seq}\t${new Date(item.at).toISOString()}\t${what.length > 100 ? `${what.slice(0, 99)}…` : what}\t${outcome}${code}${exit}${duration}${from}`;
}

function query(options: AuditOptions): AuditQuery {
  if (options.outcome !== undefined && !OUTCOMES.includes(options.outcome))
    throw new Error(`--outcome must be one of ${OUTCOMES.join(", ")}.`);
  return {
    since: time(options.since, "--since"),
    until: time(options.until, "--until"),
    action: options.action,
    outcome: options.outcome as AuditQuery["outcome"],
    text: options.text,
  };
}

const print = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

/** Runs `rome-node audit <command>` against a log opened read-only. */
export async function runAudit(
  positionals: string[],
  options: AuditOptions,
  open: (path: string) => Promise<AuditStore>,
  defaultPath: string,
): Promise<void> {
  const [, command, ...rest] = positionals;
  const commands = ["status", "tail", "show", "search", "verify", "export"];
  if (!commands.includes(command ?? ""))
    throw new Error(`Usage: rome-node audit <${commands.join("|")}>. Run rome-node help audit.`);
  if (command !== "show" && rest.length)
    throw new Error(`rome-node audit ${command} takes no arguments.`);
  if (options.content !== undefined && command !== "show")
    throw new Error("--content is only supported by rome-node audit show.");
  if (options.out !== undefined && command !== "export")
    throw new Error("--out is only supported by rome-node audit export.");
  if ((options.follow || options.lines !== undefined) && command !== "tail")
    throw new Error("-f and -n are only supported by rome-node audit tail.");
  const filters = ["since", "until", "action", "outcome", "text"] as const;
  if (command !== "search" && filters.some((name) => options[name] !== undefined))
    throw new Error(
      "--since, --until, --action, --outcome, and --text are only supported by rome-node audit search.",
    );
  const audit = await open(options.db ?? defaultPath);
  try {
    const status = await audit.status();
    if (command === "status") {
      const summary = audit.summary();
      if (options.json) return print(JSON.stringify(summary));
      print(`Audit log: ${summary.path}`);
      print(
        status.state === "ok"
          ? "State: ok"
          : `State: unavailable (${status.code})\n${status.message}`,
      );
      if (status.state === "ok") {
        print(
          `Size: ${(summary.bytes / 1024 / 1024).toFixed(1)} MiB, ${summary.records} records, ${summary.requests} requests`,
        );
        if (summary.oldestAt !== null)
          print(
            `Oldest: ${new Date(summary.oldestAt).toISOString()}  Newest: ${new Date(summary.newestAt ?? 0).toISOString()}`,
          );
        if (summary.lastPrune)
          print(
            `Last prune: ${new Date(summary.lastPrune.at).toISOString()} (${String(summary.lastPrune.record.reason)})`,
          );
      }
      print(
        `Retention: ${summary.retention.maxAgeDays} days or ${summary.retention.maxBytes / 1024 / 1024 / 1024} GiB, whichever comes first. The log never leaves this computer.`,
      );
      if (status.state !== "ok") process.exitCode = 1;
      return;
    }
    if (status.state !== "ok") throw new Error(`${status.message}`);
    if (command === "verify") {
      const result = await audit.verify();
      if (options.json) print(JSON.stringify(result));
      else if (result.ok) print(`OK: ${result.records} records verified.`);
      else
        print(
          `FAILED at seq ${result.seq ?? "-"}: ${result.reason} (${result.records} records verified before it)`,
        );
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === "export") {
      if (!options.out) throw new Error("Usage: rome-node audit export --out <file>");
      await audit.export(options.out);
      print(JSON.stringify({ exported: options.out }));
      return;
    }
    if (command === "show") {
      const seq = Number(rest[0]);
      if (rest.length !== 1 || !Number.isSafeInteger(seq))
        throw new Error("Usage: rome-node audit show <seq> [--content stdin|stdout|stderr|file]");
      const item = audit.get(seq);
      if (!item) throw new Error(`No record ${seq}.`);
      if (options.content !== undefined) {
        const name = options.content as ContentName;
        if (!CONTENT.includes(name))
          throw new Error(`--content must be one of ${CONTENT.join(", ")}.`);
        const data = audit.content(name === "stdin" ? item.seq : (item.end?.seq ?? item.seq), name);
        if (!data)
          throw new Error(
            `Record ${seq} has no stored ${name} (never stored, empty, or removed by retention).`,
          );
        await new Promise<void>((resolve, reject) =>
          process.stdout.write(data, (error) => (error ? reject(error) : resolve())),
        );
        return;
      }
      return print(JSON.stringify(item, null, options.json ? undefined : 2));
    }
    const lines = options.lines === undefined ? 20 : Number(options.lines);
    if (!Number.isSafeInteger(lines) || lines < 1) throw new Error("-n must be a positive number.");
    const items = audit.list(
      command === "search" ? { ...query(options), limit: 1000 } : { limit: lines },
    );
    const show = (item: AuditItem) => print(options.json ? JSON.stringify(item) : auditLine(item));
    for (const item of items.reverse()) show(item);
    if (command === "search" || !options.follow) return;
    // Follows the log as other processes write it. A start shows when its end arrives.
    let after = items.length ? items[items.length - 1].seq : 0;
    const waiting = new Set<number>(
      items.filter((item) => item.kind === "start" && !item.end).map((item) => item.seq),
    );
    for (;;) {
      await delay(1000);
      for (const seq of [...waiting]) {
        const item = audit.get(seq);
        if (item?.end) {
          waiting.delete(seq);
          show(item);
        }
      }
      for (const item of audit.list({ afterSeq: after, limit: 1000 }).reverse()) {
        after = Math.max(after, item.seq);
        show(item);
        if (item.kind === "start" && !item.end) waiting.add(item.seq);
      }
    }
  } finally {
    audit.close();
  }
}
