/** The size past which the Projects page treats a text file as large. */
export const LARGE_TEXT_FILE_BYTES = 1024 * 1024;
const STANDARD_AUTOSAVE_DELAY_MS = 2000;
const LARGE_FILE_AUTOSAVE_DELAY_MS = 5000;

/**
 * How a project file saves itself while it is edited: Markdown and text files
 * after a short pause, a large one after a longer pause, anything else only
 * when saved by hand. The Projects page and a chat's Outputs tab share it.
 */
export function getProjectsAutoSavePolicy(file: {
  editable: boolean;
  kind: string;
  path: string;
  size: number;
}) {
  if (!file.editable || file.kind !== "text") return null;
  if (!/\.(md|mdx|txt)$/i.test(file.path)) return null;

  return {
    commit: false,
    delayMs:
      file.size > LARGE_TEXT_FILE_BYTES ? LARGE_FILE_AUTOSAVE_DELAY_MS : STANDARD_AUTOSAVE_DELAY_MS,
  };
}
