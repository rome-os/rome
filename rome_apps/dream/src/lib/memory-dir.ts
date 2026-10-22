/**
 * The guardian's memory directory, and the only place the dream's memory agent
 * can reach. That agent reads what other people wrote on Rome's accounts, and
 * core confines neither its file tools nor, on Codex, its shell, so it declares
 * no builtin tools at all: it lists, reads, and writes memory through actions
 * that refuse any path outside this directory.
 */
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Core's profile memory directory (`getProfileMemoryDir`), which an app cannot import. */
export function profileMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), ".rome", env.ROME_PROFILE || "default", "memory");
}

/**
 * The absolute path `path` names inside `memoryDir`, or an error. Refused: a
 * relative path, one outside the directory, any hidden segment (`.git` holds
 * configuration Git executes), and any symlink inside the directory, dangling
 * or not. Memory needs none of them.
 */
export async function resolveMemoryFile(
  memoryDir: string,
  path: string,
  { allowRoot = false } = {},
): Promise<{ path: string } | { error: string }> {
  if (!isAbsolute(path)) return { error: `${path} is not absolute; start it with ${memoryDir}` };
  const root = resolve(memoryDir);
  const rel = relative(root, resolve(path));
  if (rel === "" && !allowRoot) return { error: `${path} is the memory directory itself` };
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { error: `${path} is outside the memory directory ${root}` };
  }
  const segments = rel === "" ? [] : rel.split(sep);
  if (segments.some((segment) => segment.startsWith("."))) {
    return { error: `${path} has a hidden segment, which memory does not use` };
  }
  const realRoot = await realpath(root).catch(() => root);
  let current = realRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info) break;
    if (info.isSymbolicLink())
      return { error: `${path} goes through a symlink, which memory does not use` };
  }
  return { path: join(realRoot, rel) };
}
