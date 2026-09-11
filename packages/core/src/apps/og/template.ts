// packages/core/src/apps/og/template.ts
// 1200x630 social card. Fixed layout with four slots (icon, name, description,
// link); geometry and budgets match jessie_local_rome_study spec §4.4. SVG has
// no automatic wrapping, so lines are broken here by a width-unit budget.

export interface OgIcon {
  mime: "image/svg+xml" | "image/png";
  bytes: Buffer;
}

export interface OgTemplateInput {
  name: string;
  description: string;
  /** e.g. `jessie.romeos.cc/full/apps/reddit`; null hides the line. */
  link: string | null;
  icon: OgIcon | null;
}

const FONT = "Noto Sans, Helvetica, Arial, sans-serif";
const SAFE_RIGHT = 1104;

// Inner artwork of packages/web/public/icon.svg (52x52 box, no background),
// copied verbatim so the card has no runtime file dependency.
const ROME_MARK = `<g transform="translate(6 7.38) scale(0.784)" fill="#1a1a1a">
<path d="M9.27213 35.3331H38.9233C41.3072 35.3331 43.5668 34.27 45.0866 32.4335L48.0715 28.8265C48.7983 27.9482 49.1158 26.8016 48.9444 25.6747L45.8596 5.39837C45.5623 3.44405 43.8819 2 41.9051 2H16.9889C14.4932 2 12.1405 3.16467 10.6273 5.14922L2.81921 15.3892C2.19692 16.2053 1.91212 17.2294 2.02374 18.2496L3.30773 29.9857C3.64065 33.0287 6.21098 35.3331 9.27213 35.3331Z"/>
<path d="M41.9056 0C44.8706 0.000307729 47.3913 2.16638 47.8373 5.09766L50.9213 25.374C51.1784 27.0644 50.7027 28.7843 49.6127 30.1016L46.6273 33.709C44.7276 36.0044 41.9028 37.333 38.9232 37.333H9.27185C5.19048 37.3328 1.76359 34.2603 1.3197 30.2031L0.0355225 18.4668C-0.131792 16.9367 0.295602 15.4008 1.22888 14.1768L9.03748 3.93652C10.929 1.45612 13.8693 0.000108882 16.9886 0H41.9056ZM16.9886 4C15.1171 4.00011 13.353 4.87404 12.2181 6.3623L4.40955 16.6016C4.0984 17.0096 3.95628 17.5221 4.01208 18.0322L5.29626 29.7686C5.51839 31.7969 7.23139 33.3328 9.27185 33.333H38.9232C40.711 33.333 42.4065 32.5356 43.5463 31.1582L46.5306 27.5518C46.8939 27.1127 47.0528 26.539 46.9672 25.9756L43.8822 5.69922C43.7336 4.72226 42.8938 4.00031 41.9056 4H16.9886Z"/>
<path d="M12.3794 47.5269C12.3794 45.5392 12.7709 43.571 13.5315 41.7347C14.2922 39.8983 15.4071 38.2298 16.8126 36.8243C18.218 35.4188 19.8866 34.3039 21.7229 33.5433C23.5593 32.7826 25.5275 32.3911 27.5151 32.3911C29.5028 32.3911 31.471 32.7826 33.3073 33.5433C35.1437 34.3039 36.8122 35.4188 38.2177 36.8243C39.6232 38.2298 40.7381 39.8983 41.4987 41.7347C42.2594 43.571 42.6509 45.5392 42.6509 47.5269L12.3794 47.5269Z"/>
<path d="M13.5613 6.47284L15.7849 25.1512C16.0244 27.1632 17.7306 28.6784 19.7568 28.6784H44.6983C47.1437 28.6784 49.0167 26.5036 48.6541 24.0853L45.8536 5.40689C45.56 3.4487 43.8779 2 41.8978 2H17.5333C15.1367 2 13.278 4.09306 13.5613 6.47284Z" fill="white" stroke="#1a1a1a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M35.2279 11.8394H38.2279L36.6069 15.2237L39.2279 18.8394H36.2279L33.8544 15.2237L35.2279 11.8394Z" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>
<path d="M25.5321 11.8394H28.5321L29.5321 18.8394H26.5321L25.5321 11.8394Z" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>
</g>`;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Width units: CJK / fullwidth count 2, everything else 1. */
function units(text: string): number {
  let total = 0;
  for (const ch of text) total += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return total;
}

/**
 * Greedy character wrap that prefers the last space in the line (English
 * breaks on words, CJK on characters). Appends "…" when text is left over.
 */
export function wrapText(text: string, budget: number, maxLines: number): string[] {
  const chars = Array.from(text.trim());
  const lines: string[] = [];
  let cur = "";
  let i = 0;
  while (i < chars.length && lines.length < maxLines) {
    const ch = chars[i];
    if (units(cur + ch) <= budget) {
      cur += ch;
      i += 1;
      continue;
    }
    const sp = cur.lastIndexOf(" ");
    if (sp > 0 && ch !== " ") {
      lines.push(cur.slice(0, sp));
      i -= Array.from(cur.slice(sp + 1)).length;
    } else {
      lines.push(cur);
    }
    cur = "";
    while (i < chars.length && chars[i] === " ") i += 1;
  }
  if (cur && lines.length < maxLines) {
    lines.push(cur);
    cur = "";
  }
  if (cur || i < chars.length) {
    let last = (lines[lines.length - 1] ?? "").trimEnd();
    while (units(`${last}…`) > budget) last = Array.from(last).slice(0, -1).join("").trimEnd();
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

/**
 * Cuts `text` at its first sentence terminator, keeping the terminator.
 * Fullwidth terminators (`。`, `！`, `？`) end a sentence on their own, since
 * Chinese prose is conventionally written with no space before the next
 * sentence; ASCII terminators (`.`, `!`, `?`) only count when followed by
 * whitespace or end-of-string, so "e.g. " cuts but "v1.2" does not. Falls
 * back to the whole trimmed text when no terminator is found. Purely
 * mechanical — an abbreviation like "e.g." reads as a sentence end.
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^(.*?(?:[。！？]|[.!?](?=\s|$)))/s.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function iconSlot(icon: OgIcon | null): string {
  if (icon === null) {
    // Rome mark as the default app icon, centred in the 96px art box.
    return `<g transform="translate(120 212) scale(1.8462)">${ROME_MARK}</g>`;
  }
  const href = `data:${icon.mime};base64,${icon.bytes.toString("base64")}`;
  return `<image x="120" y="212" width="96" height="96" href="${href}" preserveAspectRatio="xMidYMid meet"/>`;
}

function nameSlot(name: string): string {
  const oneLine = units(name) <= 22;
  const size = oneLine ? 64 : 48;
  const lines = oneLine ? [name] : wrapText(name, 30, 2);
  const baselines = oneLine ? [282] : [248, 300];
  return lines
    .map(
      (line, idx) =>
        `<text x="264" y="${baselines[idx]}" font-family="${FONT}" font-size="${size}" font-weight="700" fill="#1f1f1f">${escapeXml(line)}</text>`,
    )
    .join("\n  ");
}

function descriptionSlot(description: string): string {
  const lines = wrapText(description, 56, 3);
  const baselines = [396, 444, 492];
  const spans = lines
    .map((line, idx) => `<tspan x="96" y="${baselines[idx]}">${escapeXml(line)}</tspan>`)
    .join("\n    ");
  return `<text font-family="${FONT}" font-size="34" fill="#333333">\n    ${spans}\n  </text>`;
}

function linkSlot(link: string | null): string {
  if (link === null) return "";
  const [line] = wrapText(link, 78, 1);
  return `<text x="${SAFE_RIGHT}" y="566" text-anchor="end" font-family="${FONT}" font-size="22" font-weight="500" fill="#8a8a8a">${escapeXml(line)}</text>`;
}

export function renderOgSvg(input: OgTemplateInput): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f6d9b8"/>
      <stop offset="0.45" stop-color="#f3c4bd"/>
      <stop offset="1" stop-color="#f4f3ef"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="130%" height="130%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>

  <g transform="translate(852 56)">
    <g transform="scale(2.1538)">${ROME_MARK}</g>
    <text x="252" y="80" text-anchor="end" font-family="${FONT}" font-size="46" font-weight="700" fill="#1f1f1f">Rome</text>
    <text x="252" y="146" text-anchor="end" font-family="${FONT}" font-size="22" font-weight="500" fill="#6b6b6b">Built on Rome</text>
  </g>

  <rect x="96" y="188" width="144" height="144" rx="32" fill="#ffffff" filter="url(#shadow)"/>
  ${iconSlot(input.icon)}

  ${nameSlot(input.name)}

  ${descriptionSlot(input.description)}

  ${linkSlot(input.link)}
</svg>
`;
}
