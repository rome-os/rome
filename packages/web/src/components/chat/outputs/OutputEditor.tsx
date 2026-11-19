import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MutableRefObject, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { FileBrowserPage } from "@/components/file-browser-page";
import type { ResolveResult } from "@/components/file-browser/store/types";
import { decodeFileBrowserRoutePath } from "@/lib/file-browser-routing";
import { LARGE_TEXT_FILE_BYTES, getProjectsAutoSavePolicy } from "@/lib/projects-autosave";
import type { ChatOutput } from "./chat-outputs";

const PROJECTS_ROOT = "projects";
const PROJECTS_API = "/api/projects";

/** Settles any unsaved edit before a host leaves the editor. See `OutputsPanel`'s `leaveGuard`. */
export type LeaveGuard = MutableRefObject<(() => Promise<boolean>) | null>;

/** Runs `leave` once the editor in `guard` has settled its unsaved edits and allowed it. */
export function leaveEditor(guard: LeaveGuard, leave: () => void) {
  const settle = guard.current;
  if (!settle) return leave();
  void settle().then((canLeave) => {
    if (canLeave) leave();
  });
}

/** The query key of the text a read-only preview shows. */
export const outputTextKey = (url: string | null) => ["chat-output-text", url] as const;

/**
 * The logical path the file browser uses (`projects/<path>`) for an output
 * that is a file in the projects folder, or null for any other output. The
 * output's link is the file's path as it is, not a URL, so each segment is
 * encoded before the browser's own decoder checks it: a name with a `%` in it
 * comes back as itself.
 */
export function projectPathOf(output: Pick<ChatOutput, "link">): string | null {
  const prefix = "/projects/";
  if (!output.link?.startsWith(prefix)) return null;
  const encoded = output.link.slice(prefix.length).split("/").map(encodeURIComponent).join("/");
  const path = decodeFileBrowserRoutePath(encoded);
  return path === null ? null : `${PROJECTS_ROOT}/${path}`;
}

/**
 * The projects-folder path an output opens for editing at, or null while it
 * cannot be edited: the projects folder says the file is editable text that
 * the Projects page saves by itself (`.txt`, `.md`, `.mdx`), of at most the size
 * it treats as large. Anything else stays a preview, since the narrow tab has
 * no room to ask for a save by hand.
 */
export function useEditablePath(output: ChatOutput, candidate: boolean): string | null {
  const path = candidate && !output.missing && output.contentUrl ? projectPathOf(output) : null;
  const resolved = useQuery({
    queryKey: ["chat-output-resolve", path],
    queryFn: async () => {
      const response = await fetch(
        `${PROJECTS_API}/resolve?path=${encodeURIComponent(path ?? "")}`,
        {
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error("Failed to resolve the file");
      return (await response.json()) as ResolveResult;
    },
    enabled: path !== null,
  });
  const file = resolved.data;
  if (!path || file?.type !== "file") return null;
  return getProjectsAutoSavePolicy(file) !== null && file.size <= LARGE_TEXT_FILE_BYTES
    ? path
    : null;
}

/**
 * One project file in the Projects page's editor, with nothing around it.
 * Edits save as they do there, and the preview it came from reads again once
 * the editor closes.
 */
export function OutputEditor({
  path,
  textUrl,
  leaveGuard,
}: {
  path: string;
  /** The content URL of the preview this stands in for. */
  textUrl: string | null;
  leaveGuard: LeaveGuard;
}) {
  const { t } = useTranslation("files");
  const queryClient = useQueryClient();
  useEffect(
    () => () => void queryClient.resetQueries({ queryKey: outputTextKey(textUrl), exact: true }),
    [queryClient, textUrl],
  );
  return (
    <FileBrowserPage
      apiBasePath={PROJECTS_API}
      autoSave={getProjectsAutoSavePolicy}
      embedded
      externalSelection={{ path, type: "file" }}
      leaveGuard={leaveGuard}
      logicalRootPath={PROJECTS_ROOT}
      rootLabel={t("projects.rootLabel")}
      searchPlaceholder={t("projects.searchPlaceholder")}
      singleFile
    />
  );
}
