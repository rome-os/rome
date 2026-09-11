#!/usr/bin/env python3
"""Post-process a pandoc HTML page into the monochrome infographic style.

- Wraps the last word(s) of every h1 and h2 in <mark> (h1 can name an
  explicit phrase with --h1-mark).
- Optionally inserts a row of big numbers (--stats) counted from the page's
  own Nouns/Verbs tables and Rules list.
- Appends the colophon footer.

Idempotent: existing <mark> in headings, an existing stats row, and an
existing colophon are removed before being re-added.
"""
import argparse
import re
import sys

MARK_RE = re.compile(r"</?mark[^>]*>")
HEADING_RE = re.compile(r"(<h([12])\b[^>]*>)(.*?)(</h\2>)", re.S)
TAG_RE = re.compile(r"<[^>]+>")
# Trailing tags or punctuation that should stay outside the mark.
TRAIL_RE = re.compile(r"((?:</[a-z]+>)*[\s.:;,!?]*)$", re.S)


def mark_phrase(inner: str, phrase: str) -> str | None:
    """Wrap the last occurrence of `phrase` in `inner` (outside of tags)."""
    idx = inner.rfind(phrase)
    if idx < 0:
        return None
    # Refuse if the match sits inside a tag.
    if inner.rfind("<", 0, idx) > inner.rfind(">", 0, idx):
        return None
    return inner[:idx] + "<mark>" + phrase + "</mark>" + inner[idx + len(phrase):]


def mark_last_words(inner: str) -> str:
    """Wrap the last word in <mark>; take two words when the last is short
    (so "revision 2.2" and "revision 1" are marked whole)."""
    trail = TRAIL_RE.search(inner)
    tail = trail.group(1) if trail else ""
    head = inner[: len(inner) - len(tail)] if tail else inner
    words = head.rsplit(None, 2)
    if not words:
        return inner
    n = 1
    if len(words) >= 2 and len(TAG_RE.sub("", words[-1])) <= 3:
        n = 2
    n = min(n, len(words))
    # rsplit collapsed whitespace; find the true start by scanning back n words.
    pos = len(head)
    for _ in range(n):
        pos = len(head[:pos].rstrip())
        m = re.search(r"\S+$", head[:pos])
        pos = m.start() if m else 0
    phrase_start = pos
    return head[:phrase_start] + "<mark>" + head[phrase_start:].rstrip() + "</mark>" + head[len(head.rstrip()):] + tail


def process_headings(html: str, h1_mark: str | None) -> str:
    def repl(m: re.Match) -> str:
        open_tag, level, inner, close_tag = m.group(1), m.group(2), m.group(3), m.group(4)
        inner = MARK_RE.sub("", inner)
        marked = None
        if level == "1" and h1_mark:
            marked = mark_phrase(inner, h1_mark)
        if marked is None:
            marked = mark_last_words(inner)
        return open_tag + marked + close_tag

    return HEADING_RE.sub(repl, html)


def count_rows_after(html: str, heading_text: str, block: str) -> int | None:
    """Count <tr> in the first <table> (or <li> in the first <ol>) after the
    h2 whose text is heading_text."""
    m = re.search(r"<h2\b[^>]*>(?:<mark>)?" + re.escape(heading_text) + r"(?:</mark>)?</h2>", html)
    if not m:
        return None
    rest = html[m.end():]
    b = re.search(r"<%s\b.*?</%s>" % (block, block), rest, re.S)
    if not b:
        return None
    if block == "table":
        body = re.search(r"<tbody>.*?</tbody>", b.group(0), re.S)
        return len(re.findall(r"<tr\b", body.group(0))) if body else None
    return len(re.findall(r"<li\b", b.group(0)))


def insert_stats(html: str) -> str:
    html = re.sub(r'<div class="stats">.*?</div>\s*', "", html, flags=re.S)
    parts = []
    for label, heading, block in (("nouns", "Nouns", "table"), ("verbs", "Verbs", "table"), ("rules", "Rules", "ol")):
        n = count_rows_after(html, heading, block)
        if n:
            parts.append('<div class="stat"><span class="n">%d</span><span class="l">%s</span></div>' % (n, label))
    if not parts:
        return html
    stats = '<div class="stats">' + "".join(parts) + "</div>\n"
    # After the first paragraph that follows the h1.
    m = re.search(r"</h1>.*?</p>\s*", html, re.S)
    if not m:
        return html
    return html[: m.end()] + stats + html[m.end():]


def append_footer(html: str, source: str) -> str:
    html = re.sub(r'\s*<footer class="colophon">.*?</footer>', "", html, flags=re.S)
    footer = (
        '<footer class="colophon"><span>Source: %s</span>'
        "<span>Design: after Evelina Judeikyte</span></footer>\n" % source
    )
    if "</body>" in html:
        return html.replace("</body>", footer + "</body>", 1)
    return html + footer


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("--h1-mark", default=None, help="phrase in the h1 to put in the black box")
    ap.add_argument("--source", required=True, help="text after 'Source: ' in the footer")
    ap.add_argument("--stats", action="store_true", help="insert the nouns/verbs/rules number row")
    args = ap.parse_args()

    with open(args.html, encoding="utf-8") as f:
        html = f.read()
    html = process_headings(html, args.h1_mark)
    if args.stats:
        html = insert_stats(html)
    html = append_footer(html, args.source)
    with open(args.html, "w", encoding="utf-8") as f:
        f.write(html)
    return 0


if __name__ == "__main__":
    sys.exit(main())
