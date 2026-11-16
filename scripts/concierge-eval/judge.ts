// Scores a scenario's answers with a strong judge model, through the Claude
// Code CLI on the host (`claude -p`), against the scenario's written rubric.
// The judge may search the web to check a fact. docs/concierge-eval.md#baseline

import { execFile } from "node:child_process";

export interface Verdict {
  /** 1 (wrong or useless) to 5 (correct, concise, in voice). */
  score: number;
  why: string;
}

export interface JudgeOptions {
  /** The CLI's model alias or id. */
  model: string;
  effort: string;
}

const INSTRUCTIONS = `You grade a personal assistant's chat replies to its owner.
Read the rubric, then the transcript. Check facts yourself when the rubric asks for a fact you are unsure of (you may search the web).
Score 1-5:
5 = correct and complete for what was asked, concise, in the voice the rubric asks for.
4 = correct, small issues of length or voice.
3 = mostly right but with a real flaw (missing part, padded, a needless question back).
2 = largely wrong or unhelpful but on topic.
1 = wrong, invented, or no answer.
Reply with only a JSON object: {"score": <1-5>, "why": "<one sentence>"}`;

export function judgePrompt(rubric: string, transcript: string): string {
  return `${INSTRUCTIONS}\n\n<rubric>\n${rubric}\n</rubric>\n\n<transcript>\n${transcript}\n</transcript>`;
}

/** The verdict in a judge's reply, or null when it holds none. */
export function parseVerdict(reply: string): Verdict | null {
  const match = reply.match(/\{[\s\S]*"score"[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown; why?: unknown };
    const score = Number(parsed.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) return null;
    return { score, why: String(parsed.why ?? "") };
  } catch {
    return null;
  }
}

export function judge(rubric: string, transcript: string, options: JudgeOptions): Promise<Verdict> {
  const args = [
    "-p",
    "--model",
    options.model,
    "--effort",
    options.effort,
    "--output-format",
    "json",
    "--allowedTools",
    "WebSearch",
    "--max-turns",
    "8",
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 },
      (error, stdout) => {
        if (error) return reject(error);
        let text = stdout;
        try {
          text = String((JSON.parse(stdout) as { result?: unknown }).result ?? stdout);
        } catch {
          // Plain text output.
        }
        const verdict = parseVerdict(text);
        if (verdict) resolve(verdict);
        else reject(new Error(`the judge gave no verdict: ${text.slice(0, 200)}`));
      },
    );
    child.stdin?.end(judgePrompt(rubric, transcript));
  });
}
