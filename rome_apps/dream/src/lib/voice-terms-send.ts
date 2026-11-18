import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { isMap, parseDocument } from "yaml";

function sendValue(text: string): unknown {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("Missing front matter delimiter");
  const document = parseDocument(lines.slice(1, end).join("\n"));
  if (
    document.errors.length ||
    document.warnings.length ||
    (document.contents !== null && !isMap(document.contents))
  ) {
    throw new Error("Invalid front matter");
  }
  return isMap(document.contents) ? document.get("send") : undefined;
}

/** Refuses changes to the root voice terms' send value. Pass an already-read file to check an edit. */
export async function voiceTermsSendError(
  memoryDir: string,
  path: string,
  next: string,
  previous?: string,
): Promise<string | null> {
  if (relative(memoryDir, path) !== "voice-terms.md") return null;
  try {
    const current =
      previous ??
      (await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }));
    const value = sendValue(next);
    const allowed =
      current === null
        ? value === undefined ||
          value === false ||
          (typeof value === "string" && /^(off|false|no)$/i.test(value))
        : Object.is(sendValue(current), value);
    return allowed
      ? null
      : "Only the guardian may change voice-terms.md's send value. Create it with send: off and preserve that value on edits.";
  } catch {
    return "Cannot verify voice-terms.md's send value. Leave the file unchanged until its front matter is readable and valid.";
  }
}
