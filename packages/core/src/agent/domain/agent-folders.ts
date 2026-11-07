import { isAbsolute, relative } from "node:path";

/** Where agents work on this instance, as the composition root finds it. */
export interface AgentFolders {
  /** The folder an agent's session works in when nothing names another. */
  defaultWorkingDir: string;
  /** The folder that holds the guardian's projects. */
  projectsFolder: string;
}

/**
 * A working directory's path under the projects folder, the path the web chat
 * shows (e.g. `default`). Null for the projects folder itself or a folder
 * outside it, such as a connection's working directory that is not a project.
 */
export function projectPath(folders: AgentFolders, workingDir: string): string | null {
  const path = relative(folders.projectsFolder, workingDir);
  if (!path || path.startsWith("..") || isAbsolute(path)) return null;
  return path;
}
