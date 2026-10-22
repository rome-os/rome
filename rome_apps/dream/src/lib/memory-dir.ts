/**
 * The guardian's memory directory, and the only place the dream's memory agent
 * can write. That agent reads what other people wrote on Rome's accounts, and
 * core does not confine an agent's own file tools, so it has none: it writes
 * through actions that refuse any path outside this directory.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Core's profile memory directory (`getProfileMemoryDir`), which an app cannot import. */
export function profileMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), ".rome", env.ROME_PROFILE || "default", "memory");
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The nearest part of `path` that exists, resolved through symlinks. */
async function realExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      const real = await realpath(current);
      return join(real, relative(current, path));
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      current = parent;
    }
  }
}

/**
 * The absolute file `path` names inside `memoryDir`, or an error. A relative
 * path is read from the memory directory. `..` segments and symlinks that lead
 * out of it are refused.
 */
export async function resolveMemoryFile(
  memoryDir: string,
  path: string,
): Promise<{ path: string } | { error: string }> {
  const root = resolve(memoryDir);
  const target = resolve(root, path);
  if (!inside(root, target)) return { error: `${path} is outside the memory directory ${root}` };
  const realRoot = await realExisting(root);
  if (!inside(realRoot, await realExisting(target))) {
    return { error: `${path} leads outside the memory directory ${root}` };
  }
  return { path: target };
}
