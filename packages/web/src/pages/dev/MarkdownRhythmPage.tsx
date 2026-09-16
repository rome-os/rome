/**
 * Markdown rhythm specimen, at `/dev/markdown-rhythm`.
 *
 * One chat-shaped reply rendered through the real `ChatMarkdown`, standard
 * density beside compact, at the width an assistant turn gets in `/chat`.
 * Every number on the page is read back from the rendered DOM: the type sizes
 * in the spec row come from `getComputedStyle`, and the optional overlay labels
 * each gap between consecutive top-level blocks with its measured pixel
 * value. Editing a `--markdown-*` token in `@rome-os/ui` changes this page
 * with no other edit, so it is where a rhythm retune is checked.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import ChatMarkdown from "@/components/chat/ChatMarkdown";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/hooks/use-theme";
import { DEFAULT_THEME_NAME, type ThemePreference } from "@/lib/theme";

const MODES: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

// The rules the tokens follow, restated where the specimen is read.
const RULES = [
  {
    title: "Leading is the unit",
    body: "Body sets 16/24. Prose is read at length, often in CJK, where 1.25 packs the lines into a slab. Every gap is a multiple of the 4px grid that line box sits on.",
  },
  {
    title: "A heading belongs to what follows",
    body: "Space before a heading is at least 1.5× the paragraph gap and at least 2.5× its own space after, at every level and after every kind of block. Two headings in a row stay tight.",
  },
  {
    title: "Hierarchy from size and space, not weight",
    body: "The heading ladder steps by at least 1.2: 16 → 20 → 24 → 30. Headings carry the same 600 as inline emphasis, so a bold label never outweighs the heading above it.",
  },
  {
    title: "An edge has no half-leading",
    body: "A fence, a quote, a table sits one grid step further from text than text does. A table is set as text in the column — header rule, row rules, cells at the body size — not as a card dropped into it.",
  },
  {
    title: "Markers hang",
    body: "List markers sit outside the text column so a wrapped item keeps its shape, and a list sits in the same rhythm as a paragraph.",
  },
];

const SAMPLES: { id: string; label: string; content: string }[] = [
  {
    id: "zh",
    label: "中文长回复",
    content: `我看了三个候选方案的实现和它们在现有代码里的落点。下面先给结论，再逐项说明取舍，最后是建议的推进顺序。

## 总体结论

推荐先做 **方案 B**：它只改 token 值，不动任何组件结构，风险最低；同时它已经解决了你最直观感受到的“标题和正文粘在一起”的问题。方案 C 和 D 都建立在 B 之上，可以作为第二步。

需要注意的是，行距和字号这两项一旦改动，会同时影响 \`TurnSummaryGroup\` 里的紧凑模式，所以在紧凑模式里也要各自验证一遍。

### 方案对比

| 方案 | 改动范围 | 风险 | 解决的问题 |
| --- | --- | --- | --- |
| A 现状 | 无 | — | — |
| B 只修邻近 | 10 个 token 值 | 低 | 标题与上下文的归属 |
| C 节奏 | token + 列表样式 | 中 | 中文行距、列表折行 |
| D 层级 + 边界 | token + 表格重排 | 高 | 字号阶梯、表格卡片 |

表格里“风险”指的是视觉回归的可能性，不是工程复杂度。D 的工程量其实不大，但表格样式一旦变了，所有已有对话都会跟着变。

### 每个方案在做什么

1. **B 只修邻近**：把 h3 上方从 16px 提到 24px，下方保持 8px。这样标题上方的空间是段落间距的 1.5 倍，读者一眼就能把标题和它下面的段落看成一组。
2. **C 节奏**：在 B 的基础上把正文行距从 1.25 改到 1.5。中文方块字的视觉密度比拉丁字母高，1.25 的行距会让一段四五行的正文读起来像一块灰色的砖；改到 1.5 之后，行与行之间有了呼吸，段落间距反而可以维持 16px 不变。
   - 列表的项目符号改为悬挂在文字列外面，这样折行后第二行会对齐第一行的文字而不是对齐符号。
   - 列表的外边距从 8px 改到 12px，加上条目自身的 4px 内边距，正好和段落间距 16px 一致。
3. **D 层级 + 边界**：把标题字号阶梯从 24/22/20/18 拉开到 30/24/20/16，并把标题字重和段内加粗统一为 600。表格不再是一个带边框和底色的卡片，而是回到文字列里，只用表头底线和行线区分。

> 一个判断标准：把页面缩小到 50%，如果还能一眼看出哪里是标题、哪里是列表、哪里是表格，节奏就是对的。

### 建议的推进顺序

先合并 B，观察一周。然后把 C 里的行距单独拿出来做一次 A/B，因为它是影响面最大的一项。最后再决定要不要做 D。

具体到代码，改动集中在两个文件：

\`\`\`css
/* packages/ui/src/styles.css */
--markdown-heading-3-space-before: var(--rome-space-6); /* 24px，原 16px */
--markdown-heading-3-space-after: var(--rome-space-2);  /* 8px，原 4px */
\`\`\`

## 风险与注意事项

- **紧凑模式**：所有 token 在 \`.rome-markdown-compact\` 里都有第二套绑定，改标准值的时候要一起改。
- **已有测试**：\`markdown-tokens.test.ts\` 断言了当前的 token 值，改动之后要同步更新。
- **Mermaid 和代码块**：它们的外边距走 \`--markdown-media-space-block\` 和 \`--markdown-code-block-space-block\`，方案 D 会一起调整。

### 一句话总结

#### 顺序

先做 B，再单独验证行距，最后决定 D。如果你同意这个顺序，我可以先把 B 做成一个 PR。`,
  },
  {
    id: "en",
    label: "English long reply",
    content: `I read the three candidate implementations and where each lands in the current code. Conclusion first, then the trade-offs, then a suggested order.

## Overall conclusion

Start with **Option B**. It changes token values only, touches no component structure, and already fixes the thing you notice first: headings glued to the paragraph above them. C and D build on B and can be a second step.

One caveat: leading and heading size both flow into the compact density used by \`TurnSummaryGroup\`, so each needs a separate check there.

### Comparison

| Option | Scope | Risk | Fixes |
| --- | --- | --- | --- |
| A Current | none | — | — |
| B Proximity | 10 token values | low | heading ownership |
| C Rhythm | tokens + list style | medium | CJK leading, wrapped lists |
| D Hierarchy + edges | tokens + table restyle | high | size ladder, table card |

"Risk" here means visual regression, not engineering effort. D is not much code, but once table styling changes every existing conversation changes with it.

### What each option does

1. **B Proximity**: raise the space above an h3 from 16px to 24px and keep 8px below. The heading now has 1.5× the paragraph gap above it, so a reader groups it with what follows at a glance.
2. **C Rhythm**: on top of B, move body leading from 1.25 to 1.5. A four-line paragraph at 1.25 reads as a grey brick; at 1.5 the lines breathe, and the paragraph gap can stay at 16px.
   - List markers hang outside the text column, so a wrapped item's second line aligns with its first line's text rather than with the bullet.
   - List margin goes from 8px to 12px, which with the item's own 4px padding matches the 16px paragraph gap.
3. **D Hierarchy + edges**: open the heading ladder from 24/22/20/18 to 30/24/20/16 and set headings to the same 600 weight as inline bold. The table stops being a bordered, tinted card and returns to the text column with a header rule and row rules only.

> A quick test: zoom the page to 50%. If you can still tell heading from list from table, the rhythm is right.

### Suggested order

Merge B and watch it for a week. Then A/B the leading change from C on its own, since it has the widest reach. Decide on D last.

The change concentrates in two files:

\`\`\`css
/* packages/ui/src/styles.css */
--markdown-heading-3-space-before: var(--rome-space-6); /* 24px, was 16px */
--markdown-heading-3-space-after: var(--rome-space-2);  /* 8px, was 4px */
\`\`\`

## Risks

- **Compact density**: every token has a second binding under \`.rome-markdown-compact\`; change both together.
- **Existing tests**: \`markdown-tokens.test.ts\` asserts today's values and needs the same edit.
- **Mermaid and code blocks**: their margins ride \`--markdown-media-space-block\` and \`--markdown-code-block-space-block\`, which D adjusts as well.

### In one line

#### Order

B first, then leading on its own, then decide on D. If this order works for you, I can open B as a PR first.`,
  },
];

interface Gap {
  top: number;
  height: number;
  label: string;
}

function blockKind(el: Element): string {
  const kind = el.getAttribute("data-streamdown") ?? el.tagName.toLowerCase();
  return kind
    .replace("heading-", "h")
    .replace("unordered-list", "ul")
    .replace("ordered-list", "ol")
    .replace("table-wrapper", "table")
    .replace("code-block", "code")
    .replace("paragraph", "p");
}

/** Gaps between consecutive top-level Markdown blocks, in the pane's frame. */
function measureGaps(pane: HTMLElement): Gap[] {
  const root = pane.querySelector(".rome-markdown");
  if (!root) return [];
  const frame = pane.getBoundingClientRect();
  const children = Array.from(root.children);
  const gaps: Gap[] = [];
  for (let i = 0; i + 1 < children.length; i++) {
    const a = children[i].getBoundingClientRect();
    const b = children[i + 1].getBoundingClientRect();
    const gap = b.top - a.bottom;
    gaps.push({
      top: a.bottom - frame.top,
      height: Math.max(gap, 0),
      label: `${blockKind(children[i])} → ${blockKind(children[i + 1])} ${Math.round(gap)}px`,
    });
  }
  return gaps;
}

type Spec = Record<"body" | "h2" | "h3" | "h4" | "table", string>;

function readSpec(pane: HTMLElement): Spec {
  const px = (el: Element, prop: "fontSize" | "lineHeight" | "fontWeight") =>
    Math.round(Number.parseFloat(getComputedStyle(el)[prop]));
  const fmt = (selector: string) => {
    const el = pane.querySelector(selector);
    return el ? `${px(el, "fontSize")}/${px(el, "lineHeight")} · ${px(el, "fontWeight")}` : "—";
  };
  return {
    body: fmt(".rome-markdown > p"),
    h2: fmt('[data-streamdown="heading-2"]'),
    h3: fmt('[data-streamdown="heading-3"]'),
    h4: fmt('[data-streamdown="heading-4"]'),
    table: fmt('[data-streamdown="table-cell"]'),
  };
}

function Pane({
  title,
  content,
  compact,
  measure,
}: {
  title: string;
  content: string;
  compact: boolean;
  measure: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [spec, setSpec] = useState<Spec | null>(null);

  const remeasure = useCallback(() => {
    const el = frameRef.current;
    if (!el) return;
    setGaps(measureGaps(el));
    setSpec(readSpec(el));
  }, []);

  useLayoutEffect(() => {
    remeasure();
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(remeasure);
    ro.observe(el);
    const md = el.querySelector(".rome-markdown");
    if (md) ro.observe(md);
    // Fonts settle after first paint; measure once more when they do.
    document.fonts?.ready.then(remeasure);
    return () => ro.disconnect();
  }, [remeasure, content, compact]);

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3">
      <h2 className="text-section text-foreground">{title}</h2>
      {spec ? (
        <dl className="grid grid-cols-5 gap-x-4 font-mono text-aux text-muted-foreground">
          {(Object.entries(spec) as [keyof Spec, string][]).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd className="text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="rounded-12 border border-border bg-background">
        {/* Same inset as an assistant turn in /chat: MessageRow body under the avatar. */}
        <div ref={frameRef} className="relative px-6 py-5">
          <ChatMarkdown className="text-foreground" compact={compact}>
            {content}
          </ChatMarkdown>
          {measure
            ? gaps.map((gap) => (
                <div key={`${gap.top}-${gap.label}`} className="pointer-events-none">
                  <div
                    className="absolute inset-x-0 border-y border-dashed border-primary/45 bg-primary/15"
                    style={{ top: gap.top, height: gap.height }}
                  />
                  <div
                    className="-translate-y-1/2 absolute right-0 whitespace-nowrap rounded-4 bg-primary px-1 font-mono text-aux text-primary-foreground"
                    style={{ top: gap.top + gap.height / 2 }}
                  >
                    {gap.label}
                  </div>
                </div>
              ))
            : null}
        </div>
      </div>
    </section>
  );
}

export default function MarkdownRhythmPage() {
  const {
    preference,
    setPreference,
    theme: themeName,
    setTheme: setThemeName,
    themes,
  } = useTheme();
  const [sampleId, setSampleId] = useState(SAMPLES[0].id);
  const [measure, setMeasure] = useState(false);
  const sample = SAMPLES.find((s) => s.id === sampleId) ?? SAMPLES[0];
  const themeOptions = useMemo(
    () => themes.map((entry) => ({ value: entry.id, label: entry.label })),
    [themes],
  );

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="font-serif text-title text-foreground">Markdown rhythm</h1>
            <Select value={sampleId} onValueChange={setSampleId}>
              <SelectTrigger size="sm" aria-label="Sample" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SAMPLES.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label htmlFor="mdr-measure" className="flex items-center gap-2 text-ui">
              <Switch id="mdr-measure" checked={measure} onCheckedChange={setMeasure} />
              Show gaps
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {themeOptions.length > 1 ? (
              <SegmentedControl
                aria-label="Theme"
                size="sm"
                options={themeOptions}
                value={themeName || DEFAULT_THEME_NAME}
                onValueChange={setThemeName}
              />
            ) : null}
            <SegmentedControl
              aria-label="Color mode"
              size="sm"
              options={MODES}
              value={preference}
              onValueChange={(value) => setPreference(value as ThemePreference)}
            />
          </div>
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-8 px-6 py-6">
        <div className="flex flex-col gap-6 xl:flex-row">
          <Pane title="Standard" content={sample.content} compact={false} measure={measure} />
          <Pane title="Compact" content={sample.content} compact measure={measure} />
        </div>

        <section className="max-w-4xl">
          <h2 className="text-section text-foreground">The rules the tokens follow</h2>
          <dl className="mt-3 grid gap-4 md:grid-cols-2">
            {RULES.map((rule) => (
              <div key={rule.title} className="rounded-8 border border-border p-4">
                <dt className="text-ui text-foreground">{rule.title}</dt>
                <dd className="mt-1 text-ui text-muted-foreground">{rule.body}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>
    </div>
  );
}
