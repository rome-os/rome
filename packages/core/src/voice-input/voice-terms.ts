import { readFile } from "node:fs/promises";
import path from "node:path";
import { isMap, parseDocument } from "yaml";
import { createLogger } from "../logger.js";
import { getProfileMemoryDir } from "../paths.js";

const log = createLogger("voice-terms");

export const MAX_VOICE_TERMS = 150;
export const MAX_VOICE_TERM_CHARS = 40;
// Leaves room below the provider's context limit, including for CJK text.
export const MAX_VOICE_TERMS_CHARS = 3_000;

/** Returns only opted-in, filtered terms, with Mine before Learned. Invalid files yield no terms. */
export function parseVoiceTerms(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return [];
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    log.warn("malformed voice terms; continuing without terms");
    return [];
  }
  try {
    const document = parseDocument(lines.slice(1, end).join("\n"));
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
      log.warn("malformed voice terms; continuing without terms");
      return [];
    }
    const send = document.get("send");
    if (send !== true && (typeof send !== "string" || !/^(on|true|yes)$/i.test(send))) return [];
  } catch {
    log.warn("malformed voice terms; continuing without terms");
    return [];
  }

  const sections: Record<string, string[]> = { mine: [], learned: [], never: [] };
  let section: string | undefined;
  for (const line of lines.slice(end + 1)) {
    if (/^#{1,6}\s/.test(line)) {
      section = /^##\s+(Mine|Learned|Never)\s*$/i.exec(line)?.[1].toLowerCase();
      continue;
    }
    const item = /^\s*[-*] (.+)$/.exec(line)?.[1].trim();
    if (section && item) sections[section].push(item);
  }
  const seen = new Set(sections.never.map((term) => term.toLowerCase()));
  const terms: string[] = [];
  let chars = 0;
  for (const term of [...sections.mine, ...sections.learned]) {
    const key = term.toLowerCase();
    if (
      seen.has(key) ||
      term.length > MAX_VOICE_TERM_CHARS ||
      /@|:\/\/|www\.|[/\\]|[A-Za-z0-9_-]{24}/i.test(term) ||
      (term.match(/\d/g)?.length ?? 0) >= 6
    )
      continue;
    if (terms.length === MAX_VOICE_TERMS || chars + term.length > MAX_VOICE_TERMS_CHARS) break;
    seen.add(key);
    terms.push(term);
    chars += term.length;
  }
  return terms;
}

/** Reads once per listening session. Missing or unreadable files never block dictation. */
export async function readVoiceTerms(
  file = path.join(getProfileMemoryDir(), "voice-terms.md"),
): Promise<string[]> {
  try {
    return parseVoiceTerms(await readFile(file, "utf8"));
  } catch {
    // File errors can contain private paths. Do not include their details.
    log.warn("could not read voice terms; continuing without terms");
    return [];
  }
}
