import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function readPrivateJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
      return null;
    throw new Error("Could not read the local credential file.");
  }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const run = promisify(execFile);
    // Git Bash can put its incompatible whoami.exe ahead of Windows system tools on PATH.
    const systemDirectory = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const { stdout } = await run(join(systemDirectory, "whoami.exe"), [
      "/user",
      "/fo",
      "csv",
      "/nh",
    ]);
    const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error("Could not determine the Windows account identity.");
    await run(join(systemDirectory, "icacls.exe"), [
      dir,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
    ]);
  } else await chmod(dir, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface CredentialStore<T> {
  load(): Promise<unknown>;
  save(value: T): Promise<void>;
  clear(): Promise<void>;
}

export function createFileCredentialStore<T>(path: string): CredentialStore<T> {
  return {
    load: () => readPrivateJson(path),
    save: (value) => writePrivateJson(path, value),
    clear: () => rm(path, { force: true }),
  };
}
