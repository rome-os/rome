// The highlights of a runtime release: a few user-facing lines, in English
// and Chinese, that the web upgrade dialog shows in place of the raw commit
// entries (docs/releases.md#github-release). A model writes them once, at
// release time, from the release's entries and their pull requests.

/** Highlights per language at most. */
export const HIGHLIGHT_LIMIT = 5;
/** Longest highlight kept, in characters. The prompt asks for less. */
const MAX_TEXT = { en: 200, zh: 100 };
/** How much of a pull request's description the model reads. */
const MAX_BODY = 3000;

export const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_MODEL = "deepseek-chat";

/** No highlights: the dialog then links the full changes instead. */
export const NO_HIGHLIGHTS = Object.freeze({ en: [], zh: [] });

const SYSTEM_PROMPT = `You write the "What's new" highlights that Rome, a personal AI agent, shows its owner before they upgrade it. You get one release's changes as JSON: breaking changes, new features and fixes, each with its pull request number, title and description.

Rules:
- Pick only changes the owner would notice while using Rome: new things they can do, and fixes to problems they could have run into. At most ${HIGHLIGHT_LIMIT}.
- Leave out internal work: tests, CI, builds, refactors, dependency updates, developer tooling, logging, monitoring, documentation.
- Leave out anything behind a feature gate, rollout flag or experiment, and anything described as not launched yet, internal-only or for staff.
- Include every breaking change the owner has to act on, first, saying what they need to do.
- For a security fix, write only "Improved security" (in Chinese "安全性改进"). Never describe the issue.
- Write for the owner, not for engineers: plain words about what they can now do or what now works. No names of internal components, files, functions, services or endpoints, no pull request numbers in the text, no jargon.
- One short sentence each: under 120 characters in English, under 60 characters in Chinese.
- When several changes make one improvement, write one highlight and cite one of their pull request numbers.
- "zh" holds the same highlights in Simplified Chinese, in the same order.
- Empty lists are a valid answer when nothing qualifies.

Answer with JSON only, in this shape:
{"en":[{"text":"...","pr":123}],"zh":[{"text":"...","pr":123}]}
Every "pr" must be one of the pull request numbers you were given.`;

/**
 * The chat messages that ask for a release's highlights.
 *
 * @param {{ breaking: Entry[], new: Entry[], fixes: Entry[] }} notes The release's entries.
 * @param {Map<number, { title: string, body: string }>} pulls Each entry's pull request.
 */
export function highlightsPrompt(notes, pulls) {
  const describe = (entries) =>
    entries
      .filter((entry) => entry.pr !== null)
      .map((entry) => {
        const pull = pulls.get(entry.pr);
        return {
          pr: entry.pr,
          scope: entry.scope,
          subject: entry.text,
          title: pull?.title ?? null,
          description: pull?.body ? pull.body.slice(0, MAX_BODY) : null,
        };
      });
  const changes = {
    breaking: describe(notes.breaking),
    new: describe(notes.new),
    fixes: describe(notes.fixes),
  };
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(changes) },
  ];
}

/**
 * The model's answer narrowed to what a reader may show: at most
 * HIGHLIGHT_LIMIT highlights per language, each citing one of the release's
 * own pull requests once, with a short single-line text. Anything else is
 * dropped. A breaking change's highlight moves first.
 *
 * @param {unknown} raw The parsed answer.
 * @param {{ breaking: Entry[], new: Entry[], fixes: Entry[] }} notes The release's entries.
 * @returns {{ en: Highlight[], zh: Highlight[] }}
 */
export function validateHighlights(raw, notes) {
  const prs = new Set(
    [...notes.breaking, ...notes.new, ...notes.fixes].map((e) => e.pr).filter((pr) => pr !== null),
  );
  const breaking = new Set(notes.breaking.map((e) => e.pr));
  const pick = (language) => {
    const items = raw && typeof raw === "object" ? raw[language] : null;
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const kept = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const { text, pr } = item;
      if (typeof text !== "string" || !Number.isInteger(pr) || !prs.has(pr) || seen.has(pr)) {
        continue;
      }
      const line = text.replace(/\s+/g, " ").trim();
      if (!line || line.length > MAX_TEXT[language]) continue;
      seen.add(pr);
      kept.push({ text: line, pr });
    }
    kept.sort((a, b) => Number(breaking.has(b.pr)) - Number(breaking.has(a.pr)));
    return kept.slice(0, HIGHLIGHT_LIMIT);
  };
  return { en: pick("en"), zh: pick("zh") };
}

/**
 * Asks the model for a release's highlights. Never throws: without a key,
 * without entries to cite, or on any failure of the call or its answer, the
 * release has NO_HIGHLIGHTS and the reason goes to stderr.
 *
 * @param {object} options
 * @param {{ breaking: Entry[], new: Entry[], fixes: Entry[] }} options.notes
 * @param {Map<number, { title: string, body: string }>} options.pulls
 * @param {string | undefined} options.apiKey
 * @param {typeof fetch} [options.fetch]
 */
export async function writeHighlights({ notes, pulls, apiKey, fetch = globalThis.fetch }) {
  const cited = [...notes.breaking, ...notes.new, ...notes.fixes].some((e) => e.pr !== null);
  if (!cited) return NO_HIGHLIGHTS;
  if (!apiKey) {
    console.error("DEEPSEEK_API_KEY is not set; the release gets no highlights.");
    return NO_HIGHLIGHTS;
  }
  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: highlightsPrompt(notes, pulls),
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`DeepSeek answered ${response.status}`);
    const reply = await response.json();
    const content = reply?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("DeepSeek's answer has no message");
    return validateHighlights(JSON.parse(content), notes);
  } catch (error) {
    console.error(
      `No highlights for this release: ${error instanceof Error ? error.message : error}`,
    );
    return NO_HIGHLIGHTS;
  }
}

/**
 * @typedef {{ scope: string | null, text: string, pr: number | null }} Entry
 * @typedef {{ text: string, pr: number }} Highlight
 */
