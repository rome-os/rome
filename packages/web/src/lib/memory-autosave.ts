const LARGE_TEXT_FILE_BYTES = 1024 * 1024;
const STANDARD_AUTOSAVE_DELAY_MS = 2000;
const LARGE_FILE_AUTOSAVE_DELAY_MS = 5000;

/**
 * How a memory file saves itself while it is edited: Markdown and text files
 * after a short pause, a large one after a longer pause, anything else only
 * when saved by hand. The Memory page and a chat's memory sheet share it.
 */
export function getMemoryAutoSavePolicy(file: {
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
