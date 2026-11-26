import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { request } from "node:http";
import { createMasker } from "./vault-mask.js";

// The `vault` command. `search` lists what is stored. `load` runs one command
// with secrets in its environment, after the guardian granted them. There is
// no way to print a value: output is masked and the masker cannot be turned off.

const DEFAULT_SOCKET = "/run/rome-signer/signer.sock";
const NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

export interface VaultIo {
  out: (bytes: Buffer | string) => void;
  err: (bytes: Buffer | string) => void;
}

const HELP = `Usage:
  vault search [query]                   List stored secrets: name, description, last used, granted until.
  vault load NAME[,NAME2] -- cmd args... Run cmd with the secrets in its environment.
  vault help

Secrets are added by the guardian in Settings > Advanced > Vault. Before you load one,
ask the guardian with the vault_apply action. Output of the command is masked:
a secret's value prints as [vault:NAME].
`;

const NO_SIGNER = "The vault is not available on this instance (no signer).";

class VaultCliError extends Error {}

function signerCall(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch {
          reject(new VaultCliError("The signer sent an unreadable answer."));
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", (error: NodeJS.ErrnoException) =>
      reject(
        new VaultCliError(
          error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EACCES"
            ? NO_SIGNER
            : "The signer did not answer.",
        ),
      ),
    );
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

interface SecretInfo {
  name: string;
  description: string;
  lastUsedAt: string | null;
  grantedUntil?: string;
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

async function search(socket: string, query: string | undefined, io: VaultIo): Promise<number> {
  const { status, body } = await signerCall(socket, "GET", "/v1/secrets");
  if (status !== 200) throw new VaultCliError("The vault could not be read.");
  const needle = query?.toLowerCase();
  const secrets = (body.secrets as SecretInfo[]).filter(
    (secret) =>
      !needle ||
      secret.name.toLowerCase().includes(needle) ||
      secret.description.toLowerCase().includes(needle),
  );
  if (secrets.length === 0) {
    io.out("No secrets found.\n");
    return 0;
  }
  io.out(
    `${table([
      ["NAME", "DESCRIPTION", "LAST USED", "GRANTED UNTIL"],
      ...secrets.map((secret) => [
        secret.name,
        secret.description || "-",
        secret.lastUsedAt ?? "never",
        secret.grantedUntil ?? "-",
      ]),
    ])}\n`,
  );
  return 0;
}

async function load(
  socket: string,
  names: string[],
  command: string[],
  env: NodeJS.ProcessEnv,
  io: VaultIo,
): Promise<number> {
  const secrets: Array<{ name: string; value: string }> = [];
  for (const name of names) {
    const { status, body } = await signerCall(
      socket,
      "POST",
      `/v1/secrets/${encodeURIComponent(name)}/release`,
    );
    if (status === 403) {
      throw new VaultCliError(
        `No grant for ${name}. Ask the guardian with the vault_apply action first.`,
      );
    }
    if (status === 404) throw new VaultCliError(`There is no secret named ${name}.`);
    if (status !== 200 || typeof body.value !== "string") {
      throw new VaultCliError(`The vault could not release ${name}.`);
    }
    secrets.push({ name, value: body.value });
  }

  // Node's error for a bad environment quotes the offending value, so none of its text is shown.
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(command[0], command.slice(1), {
      env: { ...env, ...Object.fromEntries(secrets.map((secret) => [secret.name, secret.value])) },
      stdio: ["inherit", "pipe", "pipe"],
    });
  } catch {
    throw new VaultCliError(`cannot run ${command[0]}: invalid environment`);
  }
  // The child outlives a grant on purpose: nothing here stops it at expiry.
  const forwarders = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const forward = () => child.kill(signal);
    process.on(signal, forward);
    return () => process.off(signal, forward);
  });

  const pump = (stream: NodeJS.ReadableStream, write: VaultIo["out"]) => {
    const masker = createMasker(secrets);
    return new Promise<void>((resolve) => {
      stream.on("data", (chunk: Buffer) => write(masker.write(chunk)));
      stream.on("end", () => {
        write(masker.end());
        resolve();
      });
      stream.on("error", () => resolve());
    });
  };
  const drained = Promise.all([pump(child.stdout, io.out), pump(child.stderr, io.err)]);

  const code = await new Promise<number>((resolve) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      io.err(
        `vault: cannot run ${command[0]}: ${error.code === "ENOENT" ? "not found" : "could not start"}\n`,
      );
      resolve(127);
    });
    child.on("close", (code, signal) => {
      void drained.then(() => resolve(code ?? (signal ? 128 + signalNumber(signal) : 1)));
    });
  });
  for (const stopForwarding of forwarders) stopForwarding();
  return code;
}

function signalNumber(signal: NodeJS.Signals): number {
  return { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }[signal as string] ?? 0;
}

/** Runs one `vault` invocation and returns its exit code. */
export async function runVault(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: VaultIo,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.out(HELP);
    return command === undefined ? 2 : 0;
  }
  const socket = env.ROME_SIGNER_SOCKET?.trim() || DEFAULT_SOCKET;
  try {
    if (command === "search") return await search(socket, rest[0], io);
    if (command === "load") {
      const separator = rest.indexOf("--");
      const names = (rest[0] ?? "").split(",");
      if (
        separator !== 1 ||
        separator === rest.length - 1 ||
        names.some((name) => !NAME_PATTERN.test(name))
      ) {
        io.err(`Usage: vault load NAME[,NAME2] -- cmd args...\n`);
        return 2;
      }
      return await load(socket, [...new Set(names)], rest.slice(separator + 1), env, io);
    }
    io.err(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  } catch (error) {
    // Only a message written for the guardian is shown: any other error may quote a secret.
    io.err(`vault: ${error instanceof VaultCliError ? error.message : "failed"}\n`);
    return 1;
  }
}
