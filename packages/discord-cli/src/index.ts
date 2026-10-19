import { readFile } from "node:fs/promises";
import { buildDiscordApiRequest } from "./api.js";
import {
  API_HELP,
  DiscordCliUsageError,
  TOP_LEVEL_HELP,
  jsonWasRequested,
  parseDiscordArgs,
  type ParsedApiCommand,
} from "./args.js";
import {
  CoreProtocolError,
  CoreUnavailableError,
  requestDiscordApi,
  requestDiscordAuth,
} from "./broker-client.js";
import {
  DISCORD_API_VERSION,
  type DiscordBrokerEnvelope,
  type DiscordBrokerError,
  type DiscordBrokerResponseEnvelope,
} from "@rome/api-types/discord-broker";

export interface DiscordCliDeps {
  fetch: typeof fetch;
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  internalApiPort?: string;
  channel?: string;
  now(): number;
}

export async function runDiscordCli(
  argv: string[],
  overrides: Partial<DiscordCliDeps> = {},
): Promise<number> {
  const deps = defaultDeps(overrides);
  let command;
  try {
    command = parseDiscordArgs(argv);
  } catch (error) {
    if (error instanceof DiscordCliUsageError) {
      return renderUsageError(deps, argv, error.message);
    }
    return renderRuntimeError(deps, argv, error);
  }

  if (command.kind === "help") {
    deps.stdout(command.text);
    return 0;
  }

  if (command.kind === "auth") return runAuth(command.json, deps);

  try {
    const request = await buildDiscordApiRequest(command, deps);
    return await runApi(command, request, deps);
  } catch (error) {
    if (error instanceof DiscordCliUsageError) {
      return renderUsageError(deps, argv, error.message);
    }
    return renderRuntimeError(deps, argv, error);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  return runDiscordCli(argv);
}

async function runAuth(json: boolean, deps: DiscordCliDeps): Promise<number> {
  let envelope: DiscordBrokerEnvelope;
  try {
    envelope = await requestDiscordAuth(deps);
  } catch (error) {
    return renderCoreFailure(deps, json, error, "auth");
  }

  if ("error" in envelope) {
    const exitCode = isAuthError(envelope.error) ? 4 : 1;
    if (json) {
      deps.stdout(
        jsonLine({
          schemaVersion: 1,
          ok: false,
          authenticated: isAuthError(envelope.error) ? false : null,
          error: envelope.error,
        }),
      );
    } else {
      deps.stderr(`${envelope.error.message}\n`);
    }
    return exitCode;
  }

  if (envelope.status === 401) {
    const error = {
      type: "credential_rejected",
      status: 401,
      message:
        "Discord rejected Rome's bot credential. Reconnect Discord in Settings -> Connections.",
    };
    if (json) {
      deps.stdout(jsonLine({ schemaVersion: 1, ok: false, authenticated: false, error }));
    } else {
      deps.stderr(`${error.message}\n`);
    }
    return 4;
  }

  if (envelope.status < 200 || envelope.status >= 300) {
    const error = discordApiError(envelope);
    if (json) {
      deps.stdout(jsonLine({ schemaVersion: 1, ok: false, authenticated: null, error }));
    } else {
      deps.stderr(`${error.message}\n`);
    }
    return 1;
  }

  let bot: { id: string; username: string; globalName: string | null; avatar: string | null };
  try {
    bot = projectBot(envelope.body);
  } catch (error) {
    return renderCoreFailure(deps, json, error, "auth");
  }

  if (json) {
    deps.stdout(
      jsonLine({
        schemaVersion: 1,
        ok: true,
        authenticated: true,
        source: "rome_connection",
        apiVersion: DISCORD_API_VERSION,
        bot,
      }),
    );
  } else {
    deps.stdout(
      `discord.com\n  ✓ Authenticated through Rome as @${bot.username}\n  - Bot ID: ${bot.id}\n  - API version: v10\n`,
    );
  }
  return 0;
}

async function runApi(
  command: ParsedApiCommand,
  request: Parameters<typeof requestDiscordApi>[1],
  deps: DiscordCliDeps,
): Promise<number> {
  const startedAt = deps.now();
  if (command.verbose) deps.stderr(`> ${request.method} ${request.endpoint}\n`);

  let envelope: DiscordBrokerEnvelope;
  try {
    envelope = await requestDiscordApi(deps, request);
  } catch (error) {
    if (command.verbose) deps.stderr(`! broker unavailable after ${deps.now() - startedAt}ms\n`);
    return renderCoreFailure(deps, command.json, error, "api");
  }

  if (command.verbose) {
    deps.stderr(`< broker connected\n`);
    if (!("error" in envelope)) deps.stderr(`< Discord HTTP ${envelope.status}\n`);
    deps.stderr(`= completed in ${deps.now() - startedAt}ms\n`);
  }

  if ("error" in envelope) {
    const exitCode = isAuthError(envelope.error) ? 4 : 1;
    if (command.json) {
      deps.stdout(
        jsonLine({
          schemaVersion: 1,
          ok: false,
          status: null,
          error: envelope.error,
        }),
      );
    } else {
      deps.stderr(`${envelope.error.message}\n`);
    }
    return exitCode;
  }

  if (envelope.status >= 200 && envelope.status < 300) {
    if (command.json) {
      deps.stdout(
        jsonLine({
          schemaVersion: 1,
          ok: true,
          status: envelope.status,
          ...(command.include ? { headers: envelope.headers } : {}),
          body: envelope.body,
        }),
      );
    } else {
      renderTextResponse(deps, envelope, command.include, command.silent);
    }
    return 0;
  }

  const credentialRejected = envelope.status === 401;
  const error = credentialRejected
    ? {
        type: "credential_rejected",
        code: discordCode(envelope.body),
        message:
          "Discord rejected Rome's bot credential. Reconnect Discord in Settings -> Connections.",
        details: envelope.body,
      }
    : discordApiError(envelope);
  if (command.json) {
    deps.stdout(
      jsonLine({
        schemaVersion: 1,
        ok: false,
        status: envelope.status,
        ...(command.include ? { headers: envelope.headers } : {}),
        error,
      }),
    );
  } else {
    deps.stderr(`Discord API error (${envelope.status}): ${error.message}\n`);
    if (!command.silent && envelope.body !== null) {
      deps.stderr(`${bodyText(envelope.body)}\n`);
    }
  }
  return credentialRejected ? 4 : 1;
}

function renderTextResponse(
  deps: DiscordCliDeps,
  envelope: DiscordBrokerResponseEnvelope,
  include: boolean,
  silent: boolean,
): void {
  if (include) {
    const headers = Object.entries(envelope.headers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
    deps.stdout(`HTTP ${envelope.status}\n${headers}${headers ? "\n" : ""}\n`);
  }
  if (!silent && envelope.body !== null) deps.stdout(`${bodyText(envelope.body)}\n`);
}

function renderUsageError(deps: DiscordCliDeps, argv: string[], message: string): number {
  if (jsonWasRequested(argv)) {
    deps.stdout(
      jsonLine({
        schemaVersion: 1,
        ok: false,
        error: { type: "usage", message },
      }),
    );
  } else {
    const help = argv[0] === "api" ? API_HELP : TOP_LEVEL_HELP;
    deps.stderr(`error: ${message}\n\n${help}`);
  }
  return 2;
}

function renderRuntimeError(deps: DiscordCliDeps, argv: string[], error: unknown): number {
  const message = error instanceof Error ? error.message : "Discord CLI failed.";
  if (jsonWasRequested(argv)) {
    deps.stdout(jsonLine({ schemaVersion: 1, ok: false, error: { type: "runtime", message } }));
  } else {
    deps.stderr(`${message}\n`);
  }
  return 1;
}

function renderCoreFailure(
  deps: DiscordCliDeps,
  json: boolean,
  error: unknown,
  command: "auth" | "api",
): number {
  const type = error instanceof CoreProtocolError ? "core_protocol" : "core_unavailable";
  const message =
    error instanceof CoreUnavailableError || error instanceof CoreProtocolError
      ? error.message
      : "Could not reach the local Rome Core process.";
  const result = {
    schemaVersion: 1,
    ok: false,
    ...(command === "auth" ? { authenticated: null } : { status: null }),
    error: { type, message },
  };
  if (json) deps.stdout(jsonLine(result));
  else deps.stderr(`${message}\n`);
  return 1;
}

function projectBot(value: unknown): {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoreProtocolError();
  const bot = value as Record<string, unknown>;
  if (typeof bot.id !== "string" || typeof bot.username !== "string") {
    throw new CoreProtocolError();
  }
  return {
    id: bot.id,
    username: bot.username,
    globalName: typeof bot.global_name === "string" ? bot.global_name : null,
    avatar: typeof bot.avatar === "string" ? bot.avatar : null,
  };
}

function discordApiError(envelope: DiscordBrokerResponseEnvelope): {
  type: "discord_api";
  code?: number;
  message: string;
  details: unknown;
} {
  const record =
    envelope.body && typeof envelope.body === "object" && !Array.isArray(envelope.body)
      ? (envelope.body as Record<string, unknown>)
      : null;
  return {
    type: "discord_api",
    ...(typeof record?.code === "number" ? { code: record.code } : {}),
    message:
      typeof record?.message === "string"
        ? record.message
        : `Discord API returned HTTP ${envelope.status}.`,
    details: envelope.body,
  };
}

function discordCode(body: unknown): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "number" ? code : undefined;
}

function isAuthError(error: DiscordBrokerError): boolean {
  return (
    error.type === "not_paired" ||
    error.type === "not_authenticated" ||
    error.type === "credential_rejected"
  );
}

function bodyText(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function defaultDeps(overrides: Partial<DiscordCliDeps>): DiscordCliDeps {
  let stdin: Promise<string> | null = null;
  return {
    fetch: overrides.fetch ?? globalThis.fetch,
    readFile: overrides.readFile ?? ((path) => readFile(path, "utf8")),
    readStdin:
      overrides.readStdin ??
      (() => {
        stdin ??= readProcessStdin();
        return stdin;
      }),
    stdout: overrides.stdout ?? ((text) => process.stdout.write(text)),
    stderr: overrides.stderr ?? ((text) => process.stderr.write(text)),
    internalApiPort: overrides.internalApiPort ?? process.env.INTERNAL_API_PORT,
    // An explicit undefined keeps the ambient channel out, as tests need.
    channel: "channel" in overrides ? overrides.channel : process.env.ROME_CHANNEL,
    now: overrides.now ?? Date.now,
  };
}

async function readProcessStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("");
}
