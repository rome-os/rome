import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "@rstest/core";
import {
  MAX_VOICE_TERMS,
  MAX_VOICE_TERM_CHARS,
  MAX_VOICE_TERMS_CHARS,
  parseVoiceTerms,
  readVoiceTerms,
} from "./voice-terms.js";

const enabled = (body: string, send = "on") => `---\nsend: ${send}\n---\n${body}`;

describe("voice terms", () => {
  it("reads only Mine and Learned, Mine first, preserving first spelling and excluding Never", () => {
    expect(
      parseVoiceTerms(
        enabled(`
# Voice terms
## LEARNED
- soniox
* Paraformer
## Other
- ignored
## mINe
- Soniox
*  Concierge\u0020\u0020
- concierge
- blocked
## NEVER
* BLOCKED
- paraformer
`),
      ),
    ).toEqual(["Soniox", "Concierge"]);
  });

  it.each([
    "on",
    "ON",
    "true",
    "TRUE",
    "yes",
    "YeS",
    '"on"',
  ])("accepts explicit opt-in %s", (send) => {
    expect(parseVoiceTerms(enabled("## Mine\n- Soniox", send))).toEqual(["Soniox"]);
  });

  it.each([
    "",
    "## Mine\n- Soniox",
    "---\nsend: on\n## Mine\n- Soniox",
    enabled("## Mine\n- Soniox", "off"),
    enabled("## Mine\n- Soniox", "no"),
    enabled("## Mine\n- Soniox", "1"),
    enabled("## Mine\n- Soniox", "[on]"),
    enabled("## Mine\n- Soniox", "["),
    enabled("## Mine\n- Soniox", "on\nsend: off"),
    "---\nother: on\n---\n## Mine\n- Soniox",
    "---\n- send: on\n---\n## Mine\n- Soniox",
  ])("fails closed for absent, disabled or malformed front matter", (text) => {
    expect(parseVoiceTerms(text)).toEqual([]);
  });

  it("drops private-looking, token-like and oversized items", () => {
    const rejected = [
      "a@b.test",
      "https://example.test",
      "WWW.example.test",
      "1a2b3c4d5e6",
      "a".repeat(24),
      "key " + "A_0-".repeat(6),
      "中".repeat(41),
    ];
    const accepted = [
      "GPT 5",
      "中".repeat(MAX_VOICE_TERM_CHARS),
      "a".repeat(23),
      "12345",
      "混合 Soniox",
    ];
    expect(
      parseVoiceTerms(
        enabled(`## Mine\n${[...rejected, ...accepted].map((t) => `- ${t}`).join("\n")}`),
      ),
    ).toEqual(accepted);
  });

  it("keeps slash terms but drops path-looking terms", () => {
    const kept = ["CI/CD", "A/B testing", "I/O", "TCP/IP", "PL/SQL", "a\\b"];
    const paths = [
      "/etc/hosts",
      "~/notes",
      "~\\notes",
      "./a",
      "../x",
      "a/b/c",
      "C:\\Users",
      "C:/Users",
      "\\Users",
      "a/b\\c",
    ];
    expect(
      parseVoiceTerms(enabled(`## Mine\n${[...paths, ...kept].map((t) => `- ${t}`).join("\n")}`)),
    ).toEqual(kept);
  });

  it("caps the count at 150 with Mine ahead of Learned", () => {
    const mine = Array.from({ length: MAX_VOICE_TERMS }, (_, i) => `Term ${i}`);
    expect(
      parseVoiceTerms(
        enabled(`## Learned\n- Extra\n## Mine\n${mine.map((t) => `- ${t}`).join("\n")}`),
      ),
    ).toEqual(mine);
  });

  it("stops at the next term over the character budget, including CJK", () => {
    const terms = Array.from({ length: MAX_VOICE_TERMS_CHARS / 40 }, (_, i) =>
      `${i}`.padEnd(40, "中"),
    );
    const body = `## Mine\n${terms.map((t) => `- ${t}`).join("\n")}\n## Learned\n- 额外\n- A`;
    expect(parseVoiceTerms(enabled(body))).toEqual(terms);
    expect(terms.join("").length).toBe(MAX_VOICE_TERMS_CHARS);
  });

  it("reads a file afresh and tolerates missing, malformed and unreadable files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "voice-terms-"));
    const file = path.join(dir, "voice-terms.md");
    try {
      expect(await readVoiceTerms(file)).toEqual([]);
      await writeFile(file, enabled("## Mine\n- Soniox"));
      expect(await readVoiceTerms(file)).toEqual(["Soniox"]);
      await writeFile(file, enabled("## Mine\n- Soniox", "off"));
      expect(await readVoiceTerms(file)).toEqual([]);
      await writeFile(file, "---\nsend: [\n---\n## Mine\n- Soniox");
      expect(await readVoiceTerms(file)).toEqual([]);
      await rm(file);
      await mkdir(file);
      expect(await readVoiceTerms(file)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
